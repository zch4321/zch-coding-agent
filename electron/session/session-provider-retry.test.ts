import { describe, expect, it } from 'vitest'
import { ProviderTransportError } from '../providers/http-sse-transport'
import { ProviderCompletionError } from '../providers/provider'
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
})
