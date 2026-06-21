import type { DeepSeekReasoningEffort } from '../../shared/config'

export const DEFAULT_PROVIDER_FORM = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  reasoning: 'high' as DeepSeekReasoningEffort,
  apiKey: '',
  approverModel: 'deepseek-chat',
  contextWindowTokens: null as number | null,
  maxOutputTokens: null as number | null,
  tokenEstimationMode: 'conservative' as 'conservative' | 'custom-bytes',
  bytesPerToken: 3,
}

export type ProviderForm = typeof DEFAULT_PROVIDER_FORM

export function providerFormSignature(form: ProviderForm): string {
  return JSON.stringify({
    baseURL: form.baseURL,
    model: form.model,
    reasoning: form.reasoning,
    approverModel: form.approverModel,
    contextWindowTokens: form.contextWindowTokens,
    maxOutputTokens: form.maxOutputTokens,
    tokenEstimationMode: form.tokenEstimationMode,
    bytesPerToken: form.bytesPerToken,
  })
}
