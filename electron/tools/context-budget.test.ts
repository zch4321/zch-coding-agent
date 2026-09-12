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
      { maxToolOutputBytes: 1_024 },
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
      { maxToolOutputBytes: 1_024 },
    )

    expect(JSON.stringify(bounded.content)).toContain(
      'resultPath=/tmp/session/artifacts/subagents/result.md',
    )
  })

  it.each(['file', 'directory'] as const)(
    'retains the %s type with its continuation path after truncation',
    (artifactType) => {
      for (const content of [
        [
          {
            type: 'json' as const,
            value: {
              response: 'x'.repeat(10_000),
              artifactPath: '/tmp/capture',
              artifactType,
            },
          },
        ],
        [
          {
            type: 'text' as const,
            text: `${'x'.repeat(10_000)}\n[artifactPath=/tmp/capture; artifactType=${artifactType}]`,
          },
        ],
      ]) {
        const bounded = boundToolResultProjectionForContext(
          {
            content,
            isError: false,
            truncated: false,
            outputPolicy: 'bounded',
          },
          { maxToolOutputBytes: 1024 },
        )
        const part = bounded.content[0]!
        if (part.type !== 'text')
          throw new Error('Expected a bounded text result')
        expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(1024)
        expect(part.text).toContain(
          `artifactPath=/tmp/capture; artifactType=${artifactType}`,
        )
      }
    },
  )

  it('keeps the type attached to the chosen path instead of copying it from unrelated output', () => {
    const cases = [
      {
        content: [
          {
            type: 'json' as const,
            value: {
              unrelated: { artifactType: 'file' },
              body: 'x'.repeat(10_000),
              capture: {
                artifactPath: String.raw`C:\Temp\command capture`,
                artifactType: 'directory',
              },
            },
          },
        ],
        expected: String.raw`artifactPath=C:\Temp\command capture; artifactType=directory`,
      },
      {
        content: [
          {
            type: 'text' as const,
            text: `artifactType=file\n${'x'.repeat(10_000)}\n[artifactPath=/tmp/command; artifactType=directory]`,
          },
        ],
        expected: 'artifactPath=/tmp/command; artifactType=directory',
      },
    ]
    for (const { content, expected } of cases) {
      const bounded = boundToolResultProjectionForContext(
        {
          content,
          isError: false,
          truncated: false,
          outputPolicy: 'bounded',
        },
        { maxToolOutputBytes: 1024 },
      )
      const part = bounded.content[0]!
      if (part.type !== 'text') throw new Error('Expected bounded text')
      expect(part.text.endsWith(`${expected}]`)).toBe(true)
    }
  })

  it('omits an oversized continuation as a unit instead of exceeding the byte limit', () => {
    const bounded = boundToolResultProjectionForContext(
      {
        content: [
          {
            type: 'json',
            value: {
              body: 'x'.repeat(10_000),
              artifactPath: `/tmp/${'directory/'.repeat(100)}`,
              artifactType: 'directory',
            },
          },
        ],
        isError: false,
        truncated: false,
        outputPolicy: 'bounded',
      },
      { maxToolOutputBytes: 1024 },
    )
    const part = bounded.content[0]!
    if (part.type !== 'text') throw new Error('Expected bounded text')
    expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(1024)
    expect(part.text).toContain('truncated=true')
    expect(part.text).not.toContain('artifactPath=')
    expect(part.text).not.toContain('artifactType=')
  })

  it('does not apply the per-Tool source line setting in the byte guard', () => {
    const projection = {
      content: [
        {
          type: 'text' as const,
          text: Array.from({ length: 1_000 }, () => 'x').join('\n'),
        },
      ],
      isError: false,
      truncated: false,
      outputPolicy: 'bounded' as const,
    }

    expect(
      boundToolResultProjectionForContext(projection, {
        maxToolOutputBytes: 16 * 1_024,
      }),
    ).toEqual(projection)
  })
})
