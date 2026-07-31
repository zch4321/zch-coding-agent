import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import {
  boundToolResultProjectionForContext,
  estimateTextTokens,
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
      content: [
        {
          type: 'text' as const,
          text: `HEAD-${'x'.repeat(20_000)}-TAIL`,
        },
      ],
      isError: false,
      truncated: false,
    }
    const bounded = boundToolResultProjectionForContext(
      large,
      { ...limits, maxToolResultTokens: 256, maxToolTokensPerRun: 300 },
      0,
    )

    expect(bounded.projection).toMatchObject({ truncated: true })
    expect(bounded.projection.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('HEAD-'),
    })
    expect(JSON.stringify(bounded.projection.content)).toContain('-TAIL')

    expect(
      boundToolResultProjectionForContext(
        large,
        limits,
        limits.maxToolTokensPerRun,
      ).projection,
    ).toMatchObject({
      truncated: true,
    })
    expect(
      JSON.stringify(
        boundToolResultProjectionForContext(
          large,
          limits,
          limits.maxToolTokensPerRun,
        ).projection,
      ),
    ).toContain('-TAIL')
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
      },
      { ...limits, maxToolResultTokens: 128, maxToolTokensPerRun: 128 },
      0,
    )
    const content = bounded.projection.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') return
    expect(content.text).not.toContain('\uFFFD')
    expect(content.text).toContain('开头')
    expect(content.text).toContain('结尾')
  })
})
