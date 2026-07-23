import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { boundToolResultForContext, estimateTextTokens } from './context-budget'

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
        message: expect.stringContaining('bounded preview'),
      }),
    })
    expect(
      JSON.stringify(
        boundToolResultForContext(large, limits, limits.maxToolTokensPerRun)
          .result,
      ),
    ).toContain('-TAIL')
  })
})
