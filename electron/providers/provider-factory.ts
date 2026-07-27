import type { ProviderPublicConfig, ProviderType } from '../../shared/config'
import { resolveChatCompletionsEndpoint } from '../../shared/model-route'
import { DeepSeekProvider } from './deepseek-provider'
import { GenericChatCompletionsProvider } from './generic-chat-completions-provider'
import type { ModelProvider } from './provider'

/** Resolves the endpoint owned by one concrete provider implementation. */
export function resolveProviderEndpoint(
  providerType: ProviderType,
  baseURL: string,
): string {
  switch (providerType) {
    case 'deepseek.chat-completions':
    case 'generic.chat-completions':
      return resolveChatCompletionsEndpoint(baseURL)
  }
}

/** Creates one concrete provider implementation from frozen public settings. */
export function createConfiguredProvider(
  provider: ProviderPublicConfig,
  apiKey: string,
  fetchImpl?: typeof fetch,
  endpoint?: string,
): ModelProvider {
  switch (provider.providerType) {
    case 'deepseek.chat-completions':
      return new DeepSeekProvider({
        providerId: provider.id,
        baseURL: provider.baseURL,
        apiKey,
        fetchImpl,
        endpoint,
      })
    case 'generic.chat-completions':
      return new GenericChatCompletionsProvider({
        providerId: provider.id,
        baseURL: provider.baseURL,
        apiKey,
        fetchImpl,
        endpoint,
      })
  }
}
