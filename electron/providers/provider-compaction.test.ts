import { describe, expect, it } from 'vitest'
import type { ProviderType } from '../../shared/config'
import {
  ProviderCompactCompletionError,
  syntheticCompactEvents,
  type ProviderCompactEvent,
  type ProviderEvent,
} from './provider'

function syntheticEvents(finishReason: string): AsyncIterable<ProviderEvent> {
  return (async function* () {
    yield {
      type: 'text.delta',
      delta: 'Partial checkpoint',
      raw: { type: 'delta' },
    }
    yield {
      type: 'completed',
      turn: {
        parts: [{ type: 'text', text: 'Partial checkpoint' }],
        toolCalls: [],
        usage: { totalTokens: 12, raw: { total_tokens: 12 } },
        finishReason,
      },
      rawResponse: { id: 'compact-response', finishReason },
      providerState: { phase: 'terminal' },
      timing: { ttftMs: 1, totalMs: 2, responseBytes: 3 },
    }
  })()
}

async function collectCompact(
  finishReason: string,
  providerType: ProviderType = 'generic.chat-completions',
): Promise<ProviderCompactEvent[]> {
  const result: ProviderCompactEvent[] = []
  for await (const event of syntheticCompactEvents(
    providerType,
    syntheticEvents(finishReason),
  )) {
    result.push(event)
  }
  return result
}

describe('synthetic Provider compaction', () => {
  it('accepts only a terminal completed response', async () => {
    await expect(collectCompact('completed')).resolves.toMatchObject([
      { type: 'text.delta', delta: 'Partial checkpoint' },
      {
        type: 'completed',
        compact: {
          normalizedText: 'Partial checkpoint',
          payload: { format: 'summary-text.v1' },
        },
      },
    ])
  })

  it.each([
    ['truncated', 'incomplete'],
    ['content_filter', 'rejected'],
    ['refusal', 'rejected'],
    ['provider_specific_stop', 'rejected'],
  ] as const)(
    'rejects partial text with %s finish reason',
    async (finishReason, failure) => {
      let error: unknown
      try {
        await collectCompact(finishReason)
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(ProviderCompactCompletionError)
      expect(error).toMatchObject({
        failure,
        diagnostics: {
          rawResponse: { id: 'compact-response', finishReason },
          usage: { total_tokens: 12 },
        },
      })
    },
  )
})
