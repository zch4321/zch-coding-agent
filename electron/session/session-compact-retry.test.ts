import { describe, expect, it } from 'vitest'
import {
  ProviderCompactCompletionError,
  ProviderCompactUnsupportedError,
} from '../providers/provider'
import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  compactRetryDecision,
  createCompactRetryBudget,
  shouldFallbackNativeCompact,
} from './session-compact-retry'

const diagnostics = {
  rawResponse: null,
  providerState: null,
  usage: null,
  timing: { ttftMs: null, totalMs: 0, responseBytes: 0 },
}

describe('compact retry policy', () => {
  it('respects Retry-After for transient HTTP failures', () => {
    const decision = compactRetryDecision(
      new ProviderTransportError('HTTP_ERROR', 'busy', 503, {
        retryAfterMs: 1_234,
      }),
      createCompactRetryBudget(),
    )
    expect(decision).toEqual({ corrective: false, delayMs: 1_234 })
  })

  it('does not retry billing-shaped rate limits', () => {
    expect(
      compactRetryDecision(
        new ProviderTransportError('HTTP_ERROR', 'quota', 429, {
          providerErrorCode: 'insufficient_quota',
        }),
        createCompactRetryBudget(),
      ),
    ).toBeUndefined()
  })

  it('allows one corrective truncation retry and rejects policy stops', () => {
    const budget = createCompactRetryBudget()
    const truncated = new ProviderCompactCompletionError(
      'truncated',
      'incomplete',
      diagnostics,
    )
    expect(compactRetryDecision(truncated, budget)).toEqual({
      corrective: true,
      delayMs: 0,
    })
    expect(compactRetryDecision(truncated, budget)).toBeUndefined()
    expect(
      compactRetryDecision(
        new ProviderCompactCompletionError('filtered', 'rejected', diagnostics),
        createCompactRetryBudget(),
      ),
    ).toBeUndefined()
  })

  it('falls back only for native capability failures', () => {
    expect(
      shouldFallbackNativeCompact(
        new ProviderCompactUnsupportedError('malformed native response'),
      ),
    ).toBe(true)
    expect(
      shouldFallbackNativeCompact(
        new ProviderTransportError('HTTP_ERROR', 'missing endpoint', 404),
      ),
    ).toBe(true)
    expect(
      shouldFallbackNativeCompact(
        new ProviderTransportError('HTTP_ERROR', 'unsupported field', 400, {
          providerErrorCode: 'invalid_request_error',
        }),
      ),
    ).toBe(true)
    expect(
      shouldFallbackNativeCompact(
        new ProviderTransportError('HTTP_ERROR', 'too large', 400, {
          providerErrorCode: 'context_length_exceeded',
        }),
      ),
    ).toBe(false)
    expect(
      shouldFallbackNativeCompact(
        new ProviderTransportError('HTTP_ERROR', 'unauthorized', 401),
      ),
    ).toBe(false)
    expect(
      shouldFallbackNativeCompact(
        new ProviderTransportError('HTTP_ERROR', 'busy', 503),
      ),
    ).toBe(false)
  })
})
