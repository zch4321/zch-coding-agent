import {
  ProviderCompactCompletionError,
  ProviderCompactUnsupportedError,
  ProviderCompletionError,
} from '../providers/provider'
import { ProviderTransportError } from '../providers/http-sse-transport'

const COMPACTION_FAILED_MESSAGE = '压缩失败，请重试或打开新对话。'
const MAX_COMPACT_RETRY_DELAY_MS = 60_000
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
const NATIVE_COMPACT_FALLBACK_STATUSES = new Set([404, 405, 415, 422, 501])

export const MAX_COMPACT_ATTEMPTS = 3

export interface CompactRetryBudget {
  transientRetries: number
  incompleteRetried: boolean
  invalidRetried: boolean
}

export interface CompactRetryDecision {
  corrective: boolean
  delayMs: number
}

/** Hides provider-specific compact failures behind the stable renderer message. */
export class CompactionFailedError extends Error {
  constructor(cause: unknown) {
    super(COMPACTION_FAILED_MESSAGE, { cause })
    this.name = 'CompactionFailedError'
  }
}

/** Preserves cancellation while converting all other compact failures. */
export function rethrowCompactionFailure(
  error: unknown,
  signal: AbortSignal,
): never {
  if (signal.aborted || error instanceof CompactionFailedError) throw error
  throw new CompactionFailedError(error)
}

/** Creates a fresh per-compaction retry budget. */
export function createCompactRetryBudget(): CompactRetryBudget {
  return {
    transientRetries: 0,
    incompleteRetried: false,
    invalidRetried: false,
  }
}

/** Returns whether one native protocol failure should switch to text compaction. */
export function shouldFallbackNativeCompact(error: unknown): boolean {
  if (error instanceof ProviderCompactUnsupportedError) return true
  if (
    !(error instanceof ProviderTransportError) ||
    error.code !== 'HTTP_ERROR' ||
    error.status === undefined
  ) {
    return false
  }
  const providerCode = error.providerErrorCode?.toLowerCase()
  if (
    providerCode &&
    (NON_RETRYABLE_PROVIDER_CODES.has(providerCode) ||
      CONTEXT_LIMIT_PROVIDER_CODES.has(providerCode))
  ) {
    return false
  }
  if (NATIVE_COMPACT_FALLBACK_STATUSES.has(error.status)) return true
  if (error.status !== 400) return false
  return (
    providerCode === undefined ||
    providerCode === 'invalid_request_error' ||
    providerCode.includes('unsupported') ||
    providerCode.includes('unknown')
  )
}

function retryableHttpFailure(error: ProviderTransportError): boolean {
  const providerCode = error.providerErrorCode?.toLowerCase()
  if (providerCode && NON_RETRYABLE_PROVIDER_CODES.has(providerCode)) {
    return false
  }
  return (
    error.status === 408 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  )
}

/** Consumes retry budget and classifies one compact attempt failure. */
export function compactRetryDecision(
  error: unknown,
  budget: CompactRetryBudget,
): CompactRetryDecision | undefined {
  if (error instanceof ProviderCompactCompletionError) {
    if (error.failure === 'rejected') return undefined
    if (error.failure === 'incomplete') {
      if (budget.incompleteRetried) return undefined
      budget.incompleteRetried = true
      return { corrective: true, delayMs: 0 }
    }
    if (budget.invalidRetried) return undefined
    budget.invalidRetried = true
    return { corrective: false, delayMs: 0 }
  }
  if (error instanceof ProviderTransportError) {
    if (error.code === 'ABORTED') return undefined
    const transient =
      error.code === 'NETWORK_ERROR' ||
      error.code === 'TIMED_OUT' ||
      (error.code === 'HTTP_ERROR' && retryableHttpFailure(error))
    if (transient) {
      if (budget.transientRetries >= 2) return undefined
      budget.transientRetries += 1
      const fallback = 250 * 2 ** (budget.transientRetries - 1)
      return {
        corrective: false,
        delayMs: Math.min(
          error.retryAfterMs ??
            Math.round(fallback + Math.random() * fallback * 0.25),
          MAX_COMPACT_RETRY_DELAY_MS,
        ),
      }
    }
    if (error.code !== 'INVALID_JSON' && error.code !== 'INVALID_SSE') {
      return undefined
    }
  } else if (
    !(error instanceof ProviderCompletionError || error instanceof TypeError)
  ) {
    return undefined
  }
  if (budget.invalidRetried) return undefined
  budget.invalidRetried = true
  return { corrective: false, delayMs: 0 }
}

/** Adds a stricter short-summary requirement without changing source history. */
export function correctiveCompactPrompt(original: string): string {
  return [
    original,
    '',
    'The previous compaction response was truncated.',
    'Return a shorter but complete checkpoint from the same full history.',
    'Prioritize user intent, completed work, tool evidence, and pending state.',
    'Finish within the available output budget.',
  ].join('\n')
}

/** Waits for a bounded retry delay while remaining responsive to Run abort. */
export function waitForCompactRetry(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const abort = () => finish(signal.reason ?? new Error('Run interrupted'))
    function finish(error?: unknown): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
