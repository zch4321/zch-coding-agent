import { ProviderTransportError } from '../providers/http-sse-transport'
import { ProviderCompletionError } from '../providers/provider'

const MAX_PROVIDER_RETRY_DELAY_MS = 60_000
const NON_RETRYABLE_PROVIDER_CODES = new Set([
  'billing_error',
  'billing_not_active',
  'credit_balance_too_low',
  'insufficient_quota',
  'payment_required',
])
const CONTEXT_LIMIT_PROVIDER_CODES = new Set([
  'context_length_exceeded',
  'input_too_long',
  'model_context_window_exceeded',
  'prompt_too_long',
])

export const MAX_PROVIDER_TURN_ATTEMPTS = 3

export interface ProviderTurnRetryBudget {
  transientRetries: number
  invalidCompletionRetried: boolean
}

export interface ProviderTurnRetryDecision {
  delayMs: number
}

/** Identifies a Provider stream that ended without a canonical completion. */
export class ProviderStreamIncompleteError extends TypeError {
  constructor(message = 'Provider stream ended without completion') {
    super(message)
    this.name = 'ProviderStreamIncompleteError'
  }
}

/** Creates a fresh retry budget for one logical main-model turn. */
export function createProviderTurnRetryBudget(): ProviderTurnRetryBudget {
  return {
    transientRetries: 0,
    invalidCompletionRetried: false,
  }
}

/** Consumes retry budget for transient transport and empty completion failures. */
export function providerTurnRetryDecision(
  error: unknown,
  budget: ProviderTurnRetryBudget,
): ProviderTurnRetryDecision | undefined {
  if (
    error instanceof ProviderCompletionError ||
    error instanceof ProviderStreamIncompleteError
  ) {
    if (budget.invalidCompletionRetried) return undefined
    budget.invalidCompletionRetried = true
    return { delayMs: 0 }
  }
  if (!(error instanceof ProviderTransportError)) return undefined
  if (error.code === 'ABORTED') return undefined
  if (error.code === 'INVALID_JSON' || error.code === 'INVALID_SSE') {
    if (budget.invalidCompletionRetried) return undefined
    budget.invalidCompletionRetried = true
    return { delayMs: 0 }
  }
  const transient =
    error.code === 'NETWORK_ERROR' ||
    error.code === 'TIMED_OUT' ||
    (error.code === 'HTTP_ERROR' && retryableHttpFailure(error))
  if (!transient || budget.transientRetries >= 2) return undefined
  budget.transientRetries += 1
  const fallback = 250 * 2 ** (budget.transientRetries - 1)
  return {
    delayMs: Math.min(
      error.retryAfterMs ??
        Math.round(fallback + Math.random() * fallback * 0.25),
      MAX_PROVIDER_RETRY_DELAY_MS,
    ),
  }
}

function retryableHttpFailure(error: ProviderTransportError): boolean {
  const providerCode = error.providerErrorCode?.toLowerCase()
  if (
    providerCode &&
    (NON_RETRYABLE_PROVIDER_CODES.has(providerCode) ||
      CONTEXT_LIMIT_PROVIDER_CODES.has(providerCode))
  ) {
    return false
  }
  return (
    error.status === 408 ||
    error.status === 409 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  )
}
