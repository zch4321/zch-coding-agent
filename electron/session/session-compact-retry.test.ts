import { describe, expect, it } from 'vitest'
import {
  ProviderCompactCompletionError,
  ProviderCompactUnsupportedError,
  ProviderRequestError,
} from '../providers/provider'
import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  compactRetryDecision,
  createCompactRetryBudget,
  shouldFallbackNativeCompact,
  rethrowCompactionFailure,
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

  it('never retries or falls back after an explicit policy stop and preserves its user-facing error', () => {
    const error = new ProviderRequestError(
      'blocked',
      diagnostics,
      'misalignment_policy_violation',
    )
    const budget = createCompactRetryBudget()
    expect(compactRetryDecision(error, budget)).toBeUndefined()
    expect(budget).toEqual(createCompactRetryBudget())
    expect(shouldFallbackNativeCompact(error)).toBe(false)
    expect(() =>
      rethrowCompactionFailure(error, new AbortController().signal),
    ).toThrow(error)
    for (const status of [400, 403, 422, 429, 503]) {
      const httpError = new ProviderTransportError(
        'HTTP_ERROR',
        'blocked',
        status,
        { providerErrorCode: 'misalignment_policy_violation' },
      )
      expect(
        compactRetryDecision(httpError, createCompactRetryBudget()),
      ).toBeUndefined()
      expect(shouldFallbackNativeCompact(httpError)).toBe(false)
      expect(() =>
        rethrowCompactionFailure(httpError, new AbortController().signal),
      ).toThrow(httpError)
    }
  })

  it.each(['slow_down', 'server_is_overloaded'])(
    'backs off known transient stream code %s',
    (code) => {
      const error = new ProviderRequestError('busy', diagnostics, code)
      const budget = createCompactRetryBudget()
      expect(compactRetryDecision(error, budget)).toMatchObject({
        corrective: false,
        delayMs: expect.any(Number),
      })
      expect(compactRetryDecision(error, budget)).toBeDefined()
      expect(compactRetryDecision(error, budget)).toBeUndefined()
      expect(budget.invalidRetried).toBe(false)
    },
  )

  it('does not retry unknown explicit stream errors or context-limit HTTP errors', () => {
    for (const error of [
      new ProviderRequestError('failed', diagnostics),
      new ProviderRequestError('failed', diagnostics, 'invalid_request_error'),
      new ProviderTransportError('HTTP_ERROR', 'too large', 429, {
        providerErrorCode: 'context_length_exceeded',
      }),
    ]) {
      expect(
        compactRetryDecision(error, createCompactRetryBudget()),
      ).toBeUndefined()
    }
  })

  it('declines server delays exceeding its wait budget instead of shortening them', () => {
    for (const retryAfterMs of [
      60_001,
      120_000,
      Number.MAX_VALUE,
      Infinity,
      NaN,
      -1,
    ]) {
      const budget = createCompactRetryBudget()
      expect(
        compactRetryDecision(
          new ProviderTransportError('HTTP_ERROR', 'busy', 503, {
            retryAfterMs,
          }),
          budget,
        ),
      ).toBeUndefined()
      expect(budget.transientRetries).toBe(0)
    }
    expect(
      compactRetryDecision(
        new ProviderTransportError('HTTP_ERROR', 'busy', 503, {
          retryAfterMs: 60_000,
        }),
        createCompactRetryBudget(),
      ),
    ).toEqual({ corrective: false, delayMs: 60_000 })
  })
})
