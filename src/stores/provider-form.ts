import type { ReasoningEffort } from '../../shared/config'

export const DEFAULT_PROVIDER_FORM = {
  providerId: 'deepseek',
  label: 'DeepSeek',
  profile: 'deepseek' as 'deepseek' | 'generic',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  reasoning: 'high' as ReasoningEffort,
  apiKey: '',
  approverProviderId: 'deepseek',
  approverModel: 'deepseek-v4-flash',
  contextWindowTokens: null as number | null,
  maxOutputTokens: null as number | null,
  tokenEstimationMode: 'conservative' as 'conservative' | 'custom-bytes',
  bytesPerToken: 3,
}

export type ProviderForm = typeof DEFAULT_PROVIDER_FORM

export function providerFormSignature(form: ProviderForm): string {
  return JSON.stringify({
    baseURL: form.baseURL,
    providerId: form.providerId,
    label: form.label,
    profile: form.profile,
    model: form.model,
    reasoning: form.reasoning,
    approverProviderId: form.approverProviderId,
    approverModel: form.approverModel,
    contextWindowTokens: form.contextWindowTokens,
    maxOutputTokens: form.maxOutputTokens,
    tokenEstimationMode: form.tokenEstimationMode,
    bytesPerToken: form.bytesPerToken,
  })
}
