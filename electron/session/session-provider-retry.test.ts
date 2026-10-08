import { describe, expect, it } from 'vitest'
import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  ProviderCompletionError,
  ProviderRequestError,
} from '../providers/provider'
import {
  createProviderTurnRetryBudget,
  ProviderStreamIncompleteError,
  providerTurnRetryDecision,
} from './session-provider-retry'

const diagnostics = {
  rawResponse: null,
  providerState: null,
  usage: null,
  timing: { ttftMs: null, totalMs: 0, responseBytes: 0 },
}

describe('Provider turn retry policy', () => {
  it('retries transient transport failures twice and honors Retry-After', () => {
    const budget = createProviderTurnRetryBudget()
    expect(
      providerTurnRetryDecision(
        new ProviderTransportError('HTTP_ERROR', 'busy', 503, {
          retryAfterMs: 1_234,
        }),
        budget,
      ),
    ).toEqual({ delayMs: 1_234 })
    expect(
      providerTurnRetryDecision(
        new ProviderTransportError('NETWORK_ERROR', 'disconnected'),
        budget,
      ),
    ).toBeDefined()
    expect(
      providerTurnRetryDecision(
        new ProviderTransportError('TIMED_OUT', 'timed out'),
        budget,
      ),
    ).toBeUndefined()
  })

  it('retries one empty or incomplete completion without retrying validation errors', () => {
    const budget = createProviderTurnRetryBudget()
    expect(
      providerTurnRetryDecision(
        new ProviderCompletionError('empty completion', diagnostics),
        budget,
      ),
    ).toEqual({ delayMs: 0 })
    expect(
      providerTurnRetryDecision(new ProviderStreamIncompleteError(), budget),
    ).toBeUndefined()
    expect(
      providerTurnRetryDecision(
        new TypeError('invalid canonical turn'),
        budget,
      ),
    ).toBeUndefined()
  })

  it('does not retry abort, billing, context, authentication, or missing endpoints', () => {
    for (const error of [
      new ProviderTransportError('ABORTED', 'aborted'),
      new ProviderTransportError('HTTP_ERROR', 'quota', 429, {
        providerErrorCode: 'insufficient_quota',
      }),
      new ProviderTransportError('HTTP_ERROR', 'context', 429, {
        providerErrorCode: 'context_length_exceeded',
      }),
      new ProviderTransportError('HTTP_ERROR', 'unauthorized', 401),
      new ProviderTransportError('HTTP_ERROR', 'missing', 404),
    ]) {
      expect(
        providerTurnRetryDecision(error, createProviderTurnRetryBudget()),
      ).toBeUndefined()
    }
  })

  it.each([
    'misalignment_policy_violation',
    'content_policy_violation',
    'invalid_request_error',
    'insufficient_quota',
    undefined,
  ])('does not retry an explicit stream failure with code %s', (code) => {
    const budget = createProviderTurnRetryBudget()
    expect(
      providerTurnRetryDecision(
        new ProviderRequestError('failed', diagnostics, code),
        budget,
      ),
    ).toBeUndefined()
    expect(budget).toEqual(createProviderTurnRetryBudget())
  })

  it.each(['slow_down', 'server_is_overloaded'])(
    'backs off transient stream failure %s within its retry budget',
    (code) => {
      const budget = createProviderTurnRetryBudget()
      const error = new ProviderRequestError('busy', diagnostics, code)
      expect(
        providerTurnRetryDecision(error, budget)?.delayMs,
      ).toBeGreaterThanOrEqual(250)
      expect(
        providerTurnRetryDecision(error, budget)?.delayMs,
      ).toBeGreaterThanOrEqual(500)
      expect(providerTurnRetryDecision(error, budget)).toBeUndefined()
      expect(budget.invalidCompletionRetried).toBe(false)
    },
  )

  it('declines excessive or invalid server delays without consuming retry budget', () => {
    for (const retryAfterMs of [
      60_001,
      120_000,
      Number.MAX_VALUE,
      Infinity,
      NaN,
      -1,
    ]) {
      const budget = createProviderTurnRetryBudget()
      expect(
        providerTurnRetryDecision(
          new ProviderTransportError('HTTP_ERROR', 'busy', 503, {
            retryAfterMs,
          }),
          budget,
        ),
      ).toBeUndefined()
      expect(budget.transientRetries).toBe(0)
    }
    expect(
      providerTurnRetryDecision(
        new ProviderTransportError('HTTP_ERROR', 'busy', 429, {
          retryAfterMs: 60_000,
        }),
        createProviderTurnRetryBudget(),
      ),
    ).toEqual({ delayMs: 60_000 })
  })

  it.each([
    'misalignment_policy_violation',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])(
    'does not retry terminal HTTP code %s even with a transient status',
    (providerErrorCode) => {
      expect(
        providerTurnRetryDecision(
          new ProviderTransportError('HTTP_ERROR', 'blocked', 429, {
            providerErrorCode,
          }),
          createProviderTurnRetryBudget(),
        ),
      ).toBeUndefined()
    },
  )
})
