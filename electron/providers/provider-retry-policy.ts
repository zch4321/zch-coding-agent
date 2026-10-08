const MAX_PROVIDER_RETRY_DELAY_MS = 60_000
const NON_RETRYABLE_PROVIDER_CODES = new Set([
  'billing_error',
  'billing_not_active',
  'credit_balance_too_low',
  'insufficient_quota',
  'payment_required',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'context_length_exceeded',
  'input_too_long',
  'model_context_window_exceeded',
  'prompt_too_long',
  'misalignment_policy_violation',
  'content_policy_violation',
  'content_filter',
])
const TRANSIENT_PROVIDER_CODES = new Set([
  'slow_down',
  'rate_limit_exceeded',
  'rate_limit_error',
  'server_is_overloaded',
  'server_error',
  'internal_error',
  'service_unavailable_error',
])

/** Rejects billing, context and policy failures before HTTP retry or compact fallback. */
export function isTerminalProviderErrorCode(code: string | undefined): boolean {
  return (
    code !== undefined && NON_RETRYABLE_PROVIDER_CODES.has(code.toLowerCase())
  )
}

/** Allows only documented transient failures to retry after an explicit stream error. */
export function isTransientProviderErrorCode(
  code: string | undefined,
): boolean {
  return code !== undefined && TRANSIENT_PROVIDER_CODES.has(code.toLowerCase())
}

/** Honors server retry delays or declines retries that exceed the application wait budget. */
export function providerRetryDelay(
  retryAfterMs: number | undefined,
  retryNumber: number,
): number | undefined {
  if (retryAfterMs !== undefined) {
    return Number.isFinite(retryAfterMs) &&
      retryAfterMs >= 0 &&
      retryAfterMs <= MAX_PROVIDER_RETRY_DELAY_MS
      ? Math.ceil(retryAfterMs)
      : undefined
  }
  const fallback = 250 * 2 ** (retryNumber - 1)
  return Math.min(
    Math.round(fallback + Math.random() * fallback * 0.25),
    MAX_PROVIDER_RETRY_DELAY_MS,
  )
}
