import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProviderPublicConfig } from '../../shared/config'
import { useAgentSettingsStore } from './agent-settings'

function provider(): ProviderPublicConfig {
  return {
    id: 'provider-a',
    label: 'Provider A',
    providerType: 'generic.chat-completions',
    revision: 1,
    baseURL: 'https://provider.example/v1',
    model: 'enabled-model',
    reasoning: 'off',
    modelCatalog: [{ id: 'enabled-model' }, { id: 'catalog-only-model' }],
    modelOverrides: {},
    enabledModelIds: ['enabled-model'],
    credentialConfigured: true,
    credentialSource: 'safe-storage',
  }
}

describe('agent settings model pool', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('uses enabled models for selectors while retaining the full transfer catalog', () => {
    const settings = useAgentSettingsStore()
    const configuredProvider = provider()
    settings.providers = [configuredProvider]
    settings.activeProviderId = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id
    settings.providerForm.model = configuredProvider.model
    settings.providerForm.enabledModelIds = [
      ...configuredProvider.enabledModelIds,
    ]
    settings.approvalForm.providerId = configuredProvider.id
    settings.modelProfiles = [
      {
        id: 'enabled-model',
        availability: 'provider',
        capabilitySource: 'default',
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 65_536,
      },
      {
        id: 'catalog-only-model',
        availability: 'provider',
        capabilitySource: 'default',
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 65_536,
      },
    ]

    expect(settings.modelOptions.map((option) => option.value)).toEqual([
      'enabled-model',
    ])
    expect(settings.modelTransferOptions.map((option) => option.value)).toEqual(
      ['catalog-only-model', 'enabled-model'],
    )
    expect(settings.approvalModelOptions.map((option) => option.value)).toEqual(
      ['enabled-model'],
    )
    expect(settings.providerCardSummaries[0]?.models).toEqual(['enabled-model'])
  })
})
