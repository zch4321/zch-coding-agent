import { describe, expect, it } from 'vitest'
import { ProviderCompactCompletionError } from '../providers/provider'
import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  compactRetryDecision,
  createCompactRetryBudget,
  waitForCompactRetry,
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

  it('interrupts a pending retry delay', async () => {
    const controller = new AbortController()
    const pending = waitForCompactRetry(60_000, controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
  })
})
