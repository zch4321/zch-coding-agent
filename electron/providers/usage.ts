import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import type { LlmUsageRecord } from '../../shared/usage'
import { resolveModelProfiles, type ModelProfile } from './model-catalog'
import type { ProviderUsage } from './provider'

/** Normalizes provider usage against the exact model frozen for the call. */
export function normalizeLlmUsage(input: {
  scope: LlmUsageRecord['scope']
  config: PublicConfig
  provider: ProviderPublicConfig
  model: string
  modelProfile?: ModelProfile
  usage: ProviderUsage
}): LlmUsageRecord | undefined {
  if (
    input.usage.promptTokens === undefined &&
    input.usage.completionTokens === undefined &&
    input.usage.totalTokens === undefined &&
    input.usage.reasoningTokens === undefined &&
    input.usage.cacheHitTokens === undefined &&
    input.usage.cacheMissTokens === undefined
  ) {
    return undefined
  }
  const model =
    input.modelProfile ??
    resolveModelProfiles(input.config, input.provider.id, input.model).find(
      (candidate) => candidate.id === input.model,
    )

  return {
    scope: input.scope,
    providerId: input.provider.id,
    providerLabel: input.provider.label,
    model: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    reasoningTokens: input.usage.reasoningTokens,
    cacheHitTokens: input.usage.cacheHitTokens,
    cacheMissTokens: input.usage.cacheMissTokens,
    contextWindowTokens:
      model?.contextWindowTokens ?? input.config.limits.maxContextTokens,
    contextWindowSource: model?.capabilitySource ?? 'default',
    raw: input.usage.raw,
  }
}
