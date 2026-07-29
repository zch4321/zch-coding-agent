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
