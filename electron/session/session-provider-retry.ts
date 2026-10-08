import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  ProviderCompletionError,
  ProviderRequestError,
} from '../providers/provider'
import {
  isTerminalProviderErrorCode,
  isTransientProviderErrorCode,
  providerRetryDelay,
} from '../providers/provider-retry-policy'

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
  if (error instanceof ProviderRequestError) {
    if (!isTransientProviderErrorCode(error.providerErrorCode)) return undefined
    return transientRetryDecision(undefined, budget)
  }
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
  return transient
    ? transientRetryDecision(error.retryAfterMs, budget)
    : undefined
}

function transientRetryDecision(
  retryAfterMs: number | undefined,
  budget: ProviderTurnRetryBudget,
): ProviderTurnRetryDecision | undefined {
  if (budget.transientRetries >= 2) return undefined
  const delayMs = providerRetryDelay(retryAfterMs, budget.transientRetries + 1)
  if (delayMs === undefined) return undefined
  budget.transientRetries += 1
  return { delayMs }
}

function retryableHttpFailure(error: ProviderTransportError): boolean {
  if (isTerminalProviderErrorCode(error.providerErrorCode)) return false
  return (
    error.status === 408 ||
    error.status === 409 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  )
}
