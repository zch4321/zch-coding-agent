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
  const defaultOutput = Math.max(
    1,
    Math.min(8_192, Math.floor(input.contextWindowTokens * 0.2)),
  )
  const maxOutputTokens = Math.min(
    input.maxOutputTokens ?? defaultOutput,
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
