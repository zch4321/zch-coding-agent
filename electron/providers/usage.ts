import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { LlmUsageRecord } from '../../shared/usage'
import { resolveModelProfiles } from './model-catalog'

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function objectField(value: unknown, key: string): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const field = Reflect.get(value, key)
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as JsonObject)
    : undefined
}

export function normalizeLlmUsage(input: {
  scope: LlmUsageRecord['scope']
  config: PublicConfig
  provider: ProviderPublicConfig
  raw: JsonValue
}): LlmUsageRecord | undefined {
  if (!input.raw || typeof input.raw !== 'object' || Array.isArray(input.raw)) {
    return undefined
  }

  const usage = input.raw as JsonObject
  const completionDetails = objectField(usage, 'completion_tokens_details')
  const model = resolveModelProfiles(input.config, input.provider.id).find(
    (candidate) => candidate.id === input.provider.model,
  )

  return {
    scope: input.scope,
    providerId: input.provider.id,
    providerLabel: input.provider.label,
    model: input.provider.model,
    promptTokens: metric(usage.prompt_tokens),
    completionTokens: metric(usage.completion_tokens),
    totalTokens: metric(usage.total_tokens),
    reasoningTokens: metric(completionDetails?.reasoning_tokens),
    cacheHitTokens: metric(usage.prompt_cache_hit_tokens),
    cacheMissTokens: metric(usage.prompt_cache_miss_tokens),
    contextWindowTokens:
      model?.contextWindowTokens ?? input.config.limits.maxContextTokens,
    contextWindowSource: model?.capabilitySource ?? 'default',
    raw: input.raw,
  }
}
