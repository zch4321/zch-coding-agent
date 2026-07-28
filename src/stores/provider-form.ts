import type { ProviderType, ReasoningEffort } from '../../shared/config'

export const DEFAULT_PROVIDER_FORM = {
  providerId: 'deepseek',
  label: 'DeepSeek',
  providerType: 'deepseek.chat-completions' as ProviderType,
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  reasoning: 'high' as ReasoningEffort,
  apiKey: '',
  contextWindowTokens: null as number | null,
  maxOutputTokens: null as number | null,
  tokenEstimationMode: 'conservative' as 'conservative' | 'custom-bytes',
  bytesPerToken: 3,
}

export type ProviderForm = typeof DEFAULT_PROVIDER_FORM

/** Serializes the provider form fields that identify a saved provider configuration. */
export function providerFormSignature(form: ProviderForm): string {
  return JSON.stringify({
    baseURL: form.baseURL,
    providerId: form.providerId,
    label: form.label,
    providerType: form.providerType,
    model: form.model,
    reasoning: form.reasoning,
    contextWindowTokens: form.contextWindowTokens,
    maxOutputTokens: form.maxOutputTokens,
    tokenEstimationMode: form.tokenEstimationMode,
    bytesPerToken: form.bytesPerToken,
  })
}
