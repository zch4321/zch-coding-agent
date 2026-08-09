import type { JsonObject, JsonValue } from '../../shared/json'
import type { ProviderUsage } from './provider'
import { providerMetric, providerObjectField } from './provider-shared'

/** Normalizes usage split across Anthropic message-start and message-delta events. */
export function normalizedAnthropicUsage(
  startUsage: JsonValue,
  deltaUsage: JsonValue,
): ProviderUsage {
  const start =
    startUsage && typeof startUsage === 'object' && !Array.isArray(startUsage)
      ? (startUsage as JsonObject)
      : {}
  const delta =
    deltaUsage && typeof deltaUsage === 'object' && !Array.isArray(deltaUsage)
      ? (deltaUsage as JsonObject)
      : {}
  const uncachedInputTokens =
    providerMetric(delta.input_tokens) ?? providerMetric(start.input_tokens)
  const cacheCreationTokens =
    providerMetric(delta.cache_creation_input_tokens) ??
    providerMetric(start.cache_creation_input_tokens)
  const cacheReadTokens =
    providerMetric(delta.cache_read_input_tokens) ??
    providerMetric(start.cache_read_input_tokens)
  const inputTokens =
    uncachedInputTokens === undefined &&
    cacheCreationTokens === undefined &&
    cacheReadTokens === undefined
      ? undefined
      : (uncachedInputTokens ?? 0) +
        (cacheCreationTokens ?? 0) +
        (cacheReadTokens ?? 0)
  const outputTokens =
    providerMetric(delta.output_tokens) ?? providerMetric(start.output_tokens)
  const outputDetails =
    providerObjectField(delta, 'output_tokens_details') ??
    providerObjectField(start, 'output_tokens_details')
  const cacheMissTokens =
    uncachedInputTokens === undefined && cacheCreationTokens === undefined
      ? undefined
      : (uncachedInputTokens ?? 0) + (cacheCreationTokens ?? 0)
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    reasoningTokens: providerMetric(outputDetails?.thinking_tokens),
    cacheHitTokens: cacheReadTokens,
    cacheMissTokens,
    raw: {
      message_start: structuredClone(startUsage),
      message_delta: structuredClone(deltaUsage),
    },
  }
}

function sumUsageMetric(
  usages: readonly ProviderUsage[],
  field: Exclude<keyof ProviderUsage, 'raw'>,
): number | undefined {
  const values = usages
    .map((usage) => usage[field])
    .filter((value): value is number => typeof value === 'number')
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0)
    : undefined
}

/** Sums every billed Anthropic compaction iteration into one canonical usage. */
export function normalizedAnthropicCompactUsage(
  value: JsonValue,
): ProviderUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { raw: structuredClone(value) }
  }
  const usage = value as JsonObject
  if (
    !Array.isArray(usage.iterations) ||
    usage.iterations.length === 0 ||
    usage.iterations.some(
      (iteration) =>
        !iteration || typeof iteration !== 'object' || Array.isArray(iteration),
    )
  ) {
    const normalized = normalizedAnthropicUsage(usage, null)
    return { ...normalized, raw: structuredClone(value) }
  }
  const iterations = (usage.iterations as JsonObject[]).map((iteration) =>
    normalizedAnthropicUsage(iteration, null),
  )
  const promptTokens = sumUsageMetric(iterations, 'promptTokens')
  const completionTokens = sumUsageMetric(iterations, 'completionTokens')
  return {
    promptTokens,
    completionTokens,
    ...(promptTokens !== undefined && completionTokens !== undefined
      ? { totalTokens: promptTokens + completionTokens }
      : {}),
    reasoningTokens: sumUsageMetric(iterations, 'reasoningTokens'),
    cacheHitTokens: sumUsageMetric(iterations, 'cacheHitTokens'),
    cacheMissTokens: sumUsageMetric(iterations, 'cacheMissTokens'),
    raw: structuredClone(value),
  }
}
