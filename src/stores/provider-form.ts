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

/** Serializes only model rows that the user explicitly overrode. */
export function providerModelOverrides(
  models: UiModelProfile[],
): ProviderPublicConfig['modelOverrides'] {
  return Object.fromEntries(
    models
      .filter((model) => model.capabilitySource === 'override')
      .map((model) => [
        model.id,
        {
          contextWindowTokens: model.contextWindowTokens,
          compactThresholdTokens: model.compactThresholdTokens,
          maxOutputTokens: model.maxOutputTokens,
        },
      ]),
  )
}

/** Serializes the provider form fields that identify a saved provider configuration. */
export function providerFormSignature(
  form: ProviderForm,
  models: Pick<
    UiModelProfile,
    'id' | 'contextWindowTokens' | 'compactThresholdTokens' | 'maxOutputTokens'
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
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tokenEstimationMode: form.tokenEstimationMode,
    bytesPerToken: form.bytesPerToken,
  })
}
