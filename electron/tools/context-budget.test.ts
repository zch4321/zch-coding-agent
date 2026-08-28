import { describe, expect, it } from 'vitest'
import {
  boundToolResultProjectionForContext,
  estimateTextTokens,
} from './context-budget'

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

  it('bounds each result independently with a head preview', () => {
    const large = {
      content: [
        {
          type: 'text' as const,
          text: `HEAD-${'x'.repeat(20_000)}-TAIL`,
        },
      ],
      isError: false,
      truncated: false,
      outputPolicy: 'bounded' as const,
    }
    const bounded = boundToolResultProjectionForContext(large, {
      maxToolOutputBytes: 1_024,
      maxToolOutputLines: 500,
    })

    expect(bounded).toMatchObject({ truncated: true })
    expect(bounded.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('HEAD-'),
    })
    expect(JSON.stringify(bounded.content)).not.toContain('-TAIL')

    const small = {
      content: [{ type: 'text' as const, text: 'small later result' }],
      isError: false,
      truncated: false,
      outputPolicy: 'bounded' as const,
    }
    expect(
      boundToolResultProjectionForContext(small, {
        maxToolOutputBytes: 1_024,
        maxToolOutputLines: 500,
      }),
    ).toEqual(small)
  })

  it('keeps projected UTF-8 text valid when truncating on byte boundaries', () => {
    const bounded = boundToolResultProjectionForContext(
      {
        content: [
          {
            type: 'text',
            text: `开头-${'界'.repeat(2_000)}-结尾`,
          },
        ],
        isError: false,
        truncated: false,
        outputPolicy: 'bounded',
      },
      { maxToolOutputBytes: 1_024, maxToolOutputLines: 500 },
    )
    const content = bounded.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') return
    expect(content.text).not.toContain('\uFFFD')
    expect(content.text).toContain('开头')
    expect(content.text).not.toContain('结尾')
  })

  it('retains a continuation artifact path in the truncation marker', () => {
    const bounded = boundToolResultProjectionForContext(
      {
        content: [
          {
            type: 'json',
            value: {
              response: 'x'.repeat(10_000),
              resultPath: '/tmp/session/artifacts/subagents/result.md',
            },
          },
        ],
        isError: false,
        truncated: false,
        outputPolicy: 'bounded',
      },
      { maxToolOutputBytes: 1_024, maxToolOutputLines: 500 },
    )

    expect(JSON.stringify(bounded.content)).toContain(
      'resultPath=/tmp/session/artifacts/subagents/result.md',
    )
  })
})
