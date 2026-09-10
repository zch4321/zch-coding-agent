import { describe, expect, it, vi } from 'vitest'
import { observeProviderUsage } from './usage-observer'
import {
  ProviderCompletionError,
  type ProviderEvent,
  type ProviderUsage,
} from './provider'
import { withProviderFailureUsage } from './provider-failure-usage'

const usage: ProviderUsage = {
  promptTokens: 12,
  completionTokens: 3,
  raw: null,
}
const completed: ProviderEvent = {
  type: 'completed',
  turn: {
    parts: [{ type: 'text', text: 'answer' }],
    toolCalls: [],
    usage,
    finishReason: 'stop',
  },
  rawResponse: null,
  providerState: null,
  timing: { ttftMs: 0, totalMs: 1, responseBytes: 1 },
}

async function consume(events: AsyncIterable<ProviderEvent>) {
  for await (const event of events) void event
}

describe('source usage observer', () => {
  it('retains received metrics on a transport abort without changing the error used for retries', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    async function* transport(): AsyncIterable<ProviderEvent> {
      yield await Promise.reject(abort)
    }
    const record = vi.fn(async () => undefined)
    const source = withProviderFailureUsage(transport(), () => usage)
    await expect(
      consume(observeProviderUsage(source, 'generic.chat-completions', record)),
    ).rejects.toBe(abort)
    expect(record).toHaveBeenCalledExactlyOnceWith(usage)
  })
  it('records before caller validation, without counting duplicate completions or a later failure twice', async () => {
    const record = vi.fn(async () => undefined)
    async function* stream() {
      yield completed
      yield completed
      throw new Error('later failure')
    }
    await expect(
      consume(
        observeProviderUsage(stream(), 'generic.chat-completions', record),
      ),
    ).rejects.toThrow('later failure')
    expect(record).toHaveBeenCalledExactlyOnceWith(usage)
  })

  it.each([
    [
      'generic.chat-completions',
      { prompt_tokens: 100, completion_tokens: 20 },
      { promptTokens: 100, completionTokens: 20 },
    ],
    [
      'generic.responses',
      { input_tokens: 101, output_tokens: 21 },
      { promptTokens: 101, completionTokens: 21 },
    ],
    [
      'generic.anthropic',
      {
        message_start: { input_tokens: 10, cache_read_input_tokens: 30 },
        message_delta: { output_tokens: 22 },
      },
      { promptTokens: 40, cacheHitTokens: 30, completionTokens: 22 },
    ],
  ] as const)(
    'preserves received usage on rejected %s completions',
    async (providerType, raw, expected) => {
      const record = vi.fn(async () => undefined)
      const error = new ProviderCompletionError('rejected', {
        usage: raw,
        rawResponse: null,
        providerState: null,
        timing: { ttftMs: null, totalMs: 1, responseBytes: 1 },
      })
      async function* stream(): AsyncIterable<ProviderEvent> {
        yield await Promise.reject(error)
      }
      await expect(
        consume(observeProviderUsage(stream(), providerType, record)),
      ).rejects.toBe(error)
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(expected),
      )
    },
  )
})
