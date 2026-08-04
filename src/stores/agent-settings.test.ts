// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { ProviderPublicConfig } from '../../shared/config'
import { useAgentSettingsStore } from './agent-settings'
import { providerFormSignature } from './provider-form'

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
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

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

  it('filters approval models by the effective approval reasoning effort', () => {
    const settings = useAgentSettingsStore()
    const configuredProvider = {
      ...provider(),
      reasoning: 'off' as const,
      enabledModelIds: ['enabled-model', 'low-only-model', 'off-only-model'],
      modelOverrides: {
        'low-only-model': {
          reasoningEfforts: ['low' as const],
        },
        'off-only-model': {
          reasoningEfforts: ['off' as const],
        },
      },
    }
    settings.providers = [configuredProvider]
    settings.approvalForm.providerId = configuredProvider.id

    // The provider default 'off' escalates to 'high' for approval routing, so
    // annotated models without 'high' support are not offered.
    expect(settings.approvalModelOptions.map((option) => option.value)).toEqual(
      ['enabled-model'],
    )
  })

  it('keeps an unsaved Provider draft dirty after loading its model catalog', async () => {
    const settings = useAgentSettingsStore()
    const configuredProvider = provider()
    settings.providers = [configuredProvider]
    settings.activeProviderId = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id
    settings.hydrateSelectedProviderForm()
    settings.providerSavedSignature = providerFormSignature(
      settings.providerForm,
      settings.modelProfiles,
    )
    const savedSignature = settings.providerSavedSignature
    settings.providerForm.label = 'Unsaved Provider label'

    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listProviderModels: vi.fn(async () => ({
          version: 1 as const,
          ok: true as const,
          value: {
            models: [
              {
                id: 'enabled-model',
                availability: 'provider' as const,
                capabilitySource: 'provider' as const,
                contextWindowTokens: 300_000,
                compactThresholdTokens: 200_000,
                maxOutputTokens: 50_000,
              },
            ],
            fetchedAt: '2026-08-03T00:00:00.000Z',
            stale: false,
          },
        })),
      } as Partial<AgentApi> as AgentApi,
    })

    expect(settings.providerDirty).toBe(true)
    await expect(settings.loadProviderModels(false)).resolves.toBe(true)

    expect(settings.providerSavedSignature).toBe(savedSignature)
    expect(settings.providerDirty).toBe(true)
    expect(settings.providerForm.label).toBe('Unsaved Provider label')
    expect(settings.modelCatalogFetchedAt).toBe('2026-08-03T00:00:00.000Z')
  })

  it('maps saved annotations into profiles without changing token source semantics', () => {
    const settings = useAgentSettingsStore()
    const configuredProvider = provider()
    configuredProvider.modelOverrides = {
      'enabled-model': {
        reasoningEfforts: ['low', 'medium'],
        capability: 'light',
      },
    }
    settings.providers = [configuredProvider]
    settings.activeProviderId = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id

    settings.hydrateSelectedProviderForm()

    const profile = settings.modelProfiles.find(
      (model) => model.id === 'enabled-model',
    )
    expect(profile?.reasoningEfforts).toEqual(['low', 'medium'])
    expect(profile?.capability).toBe('light')
    expect(profile?.capabilitySource).toBe('default')
  })

  it('updates and clears per-model annotations without touching capabilitySource', () => {
    const settings = useAgentSettingsStore()
    settings.modelProfiles = [
      {
        id: 'model-a',
        availability: 'provider',
        capabilitySource: 'provider',
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 65_536,
      },
    ]

    settings.updateModelAnnotation('model-a', {
      reasoningEfforts: ['high', 'max'],
      capability: 'strong',
    })
    expect(settings.modelProfiles[0]).toMatchObject({
      reasoningEfforts: ['high', 'max'],
      capability: 'strong',
      capabilitySource: 'provider',
    })

    settings.updateModelAnnotation('model-a', {
      reasoningEfforts: [],
      capability: null,
    })
    expect(settings.modelProfiles[0]?.reasoningEfforts).toBeUndefined()
    expect(settings.modelProfiles[0]?.capability).toBeUndefined()
    expect(settings.modelProfiles[0]?.capabilitySource).toBe('provider')
  })
})
