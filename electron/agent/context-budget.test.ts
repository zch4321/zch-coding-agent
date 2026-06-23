import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import type { ProviderMessage } from '../providers/provider'
import {
  boundToolResultForContext,
  estimateTextTokens,
  selectContextMessages,
} from './context-budget'

const limits = toPublicConfig(DEFAULT_APP_CONFIG, false).limits

describe('context budget', () => {
  it('supports conservative and user-defined UTF-8 byte ratios', () => {
    expect(
      estimateTextTokens('abcdef', {
        mode: 'conservative',
        bytesPerToken: 9,
      }),
    ).toBe(2)
    expect(
      estimateTextTokens('你好', {
        mode: 'custom-bytes',
        bytesPerToken: 2,
      }),
    ).toBe(3)
  })

  it('bounds a result with head and tail and enforces the run budget', () => {
    const large = {
      status: 'ok' as const,
      content: `HEAD-${'x'.repeat(20_000)}-TAIL`,
    }
    const bounded = boundToolResultForContext(
      large,
      { ...limits, maxToolResultTokens: 256, maxToolTokensPerRun: 300 },
      0,
    )

    expect(bounded.result).toMatchObject({ status: 'ok', truncated: true })
    expect(JSON.stringify(bounded.result)).toContain('HEAD-')
    expect(JSON.stringify(bounded.result)).toContain('-TAIL')

    expect(
      boundToolResultForContext(large, limits, limits.maxToolTokensPerRun)
        .result,
    ).toMatchObject({
      status: 'ok',
      truncated: true,
      content: expect.objectContaining({
        message: expect.stringContaining('budget is exhausted'),
      }),
    })
  })

  it('drops complete old turns without orphaning tool results', () => {
    const oldToolCall = { id: 'call-old', type: 'function' }
    const history: ProviderMessage[] = [
      { role: 'user', content: `old-${'x'.repeat(3_000)}` },
      { role: 'assistant', content: null, tool_calls: [oldToolCall] },
      { role: 'tool', tool_call_id: 'call-old', content: 'old result' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'latest question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-new', type: 'function' }],
      },
      { role: 'tool', tool_call_id: 'call-new', content: 'latest result' },
    ]
    const selected = selectContextMessages({
      system: { role: 'system', content: 'system' },
      history,
      maxPromptTokens: 300,
      estimation: limits.tokenEstimation,
    })

    expect(
      selected.some((message) => message.tool_call_id === 'call-old'),
    ).toBe(false)
    expect(
      selected.some((message) => message.tool_call_id === 'call-new'),
    ).toBe(true)
    expect(
      selected.some((message) =>
        message.tool_calls?.some(
          (call) =>
            call &&
            typeof call === 'object' &&
            !Array.isArray(call) &&
            call.id === 'call-new',
        ),
      ),
    ).toBe(true)
  })

  it('rejects a latest turn that cannot fit without breaking protocol', () => {
    expect(() =>
      selectContextMessages({
        system: { role: 'system', content: 'system' },
        history: [{ role: 'user', content: 'x'.repeat(10_000) }],
        maxPromptTokens: 100,
        estimation: limits.tokenEstimation,
      }),
    ).toThrow('latest complete conversation turn')
  })
})
