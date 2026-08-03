import type {
  ProviderPublicConfig,
  ProviderType,
  ReasoningEffort,
} from '../../shared/config'
import type { UiModelProfile } from './agent-types'

export const DEFAULT_PROVIDER_FORM = {
  providerId: 'deepseek',
  label: 'DeepSeek',
  providerType: 'deepseek.chat-completions' as ProviderType,
  baseURL: 'https://api.deepseek.com',
  model: '',
  enabledModelIds: [] as string[],
  reasoning: 'high' as ReasoningEffort,
  apiKey: '',
  tokenEstimationMode: 'conservative' as 'conservative' | 'custom-bytes',
  bytesPerToken: 3,
}

export type ProviderForm = typeof DEFAULT_PROVIDER_FORM

/** True when a model row carries per-model annotation beyond token overrides. */
function hasModelAnnotation(model: UiModelProfile): boolean {
  return Boolean(model.reasoningEfforts?.length || model.capability)
}

/**
 * Serializes model rows that carry token overrides or per-model annotations.
 * Token fields are written only for explicit token overrides so annotation-only
 * rows do not freeze resolved token defaults into the saved configuration.
 */
export function providerModelOverrides(
  models: UiModelProfile[],
): ProviderPublicConfig['modelOverrides'] {
  return Object.fromEntries(
    models
      .filter(
        (model) =>
          model.capabilitySource === 'override' || hasModelAnnotation(model),
      )
      .map((model) => [
        model.id,
        {
          ...(model.capabilitySource === 'override'
            ? {
                contextWindowTokens: model.contextWindowTokens,
                compactThresholdTokens: model.compactThresholdTokens,
                maxOutputTokens: model.maxOutputTokens,
              }
            : {}),
          ...(model.reasoningEfforts?.length
            ? { reasoningEfforts: [...model.reasoningEfforts] }
            : {}),
          ...(model.capability ? { capability: model.capability } : {}),
        },
      ]),
  )
}

/** Serializes the provider form fields that identify a saved provider configuration. */
export function providerFormSignature(
  form: ProviderForm,
  models: Pick<
    UiModelProfile,
    | 'id'
    | 'contextWindowTokens'
    | 'compactThresholdTokens'
    | 'maxOutputTokens'
    | 'reasoningEfforts'
    | 'capability'
  >[] = [],
): string {
  return JSON.stringify({
    baseURL: form.baseURL,
    providerId: form.providerId,
    label: form.label,
    providerType: form.providerType,
    model: form.model,
    enabledModelIds: [...form.enabledModelIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    reasoning: form.reasoning,
    models: models
      .map((model) => ({
        id: model.id,
        contextWindowTokens: model.contextWindowTokens,
        compactThresholdTokens: model.compactThresholdTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEfforts: model.reasoningEfforts?.length
          ? [...model.reasoningEfforts]
          : null,
        capability: model.capability ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tokenEstimationMode: form.tokenEstimationMode,
    bytesPerToken: form.bytesPerToken,
  })
}
