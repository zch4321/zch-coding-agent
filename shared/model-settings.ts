import { REASONING_EFFORTS, type ReasoningEffort } from './reasoning'
import type { ProviderPublicConfig } from './config/providers'

/** Resolves an explicit image setting or catalog capability; unknown models may attempt native input. */
export function resolveImageInput(
  provider: Pick<ProviderPublicConfig, 'modelOverrides' | 'modelCatalog'>,
  model: string,
): 'supported' | 'unsupported' | 'unknown' {
  const override = provider.modelOverrides[model]?.imageInput
  if (override && override !== 'auto') return override
  const known = provider.modelCatalog.find(
    (candidate) => candidate.id === model,
  )?.imageInput
  return known === true
    ? 'supported'
    : known === false
      ? 'unsupported'
      : 'unknown'
}

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 256_000
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 65_536

export interface ModelTokenSettings {
  contextWindowTokens: number
  compactThresholdTokens: number
  maxOutputTokens: number
}

/** Resolves complete, internally consistent token settings for one model. */
export function resolveModelTokenSettings(input: {
  contextWindowTokens: number
  compactThresholdTokens?: number
  maxOutputTokens?: number
  compactTriggerPercent: number
}): ModelTokenSettings {
  const safeMaximumOutput = Math.max(1, input.contextWindowTokens - 1_024)
  const maxOutputTokens = Math.min(
    input.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    safeMaximumOutput,
  )
  const promptBudget = Math.max(
    1_024,
    input.contextWindowTokens - maxOutputTokens,
  )
  const defaultThreshold = Math.max(
    1_024,
    Math.floor((promptBudget * input.compactTriggerPercent) / 100),
  )

  return {
    contextWindowTokens: input.contextWindowTokens,
    compactThresholdTokens: Math.min(
      input.compactThresholdTokens ?? defaultThreshold,
      promptBudget,
    ),
    maxOutputTokens,
  }
}

/** Returns the effort set deduplicated and sorted in ascending strength order. */
export function normalizeReasoningEfforts(
  efforts: readonly ReasoningEffort[],
): ReasoningEffort[] {
  const strengthOrder = new Map(
    REASONING_EFFORTS.map((effort, index) => [effort, index] as const),
  )
  return [...new Set(efforts)].sort(
    (a, b) => (strengthOrder.get(a) ?? 0) - (strengthOrder.get(b) ?? 0),
  )
}

/**
 * Resolves which reasoning efforts a model supports: the annotated subset from
 * its capability override when present (returned in ascending strength order),
 * otherwise every known effort. Unannotated models keep legacy behavior.
 */
export function resolveSupportedReasoningEfforts(override?: {
  reasoningEfforts?: readonly ReasoningEffort[]
}): ReasoningEffort[] {
  if (!override?.reasoningEfforts?.length) {
    return [...REASONING_EFFORTS]
  }
  return normalizeReasoningEfforts(override.reasoningEfforts)
}
