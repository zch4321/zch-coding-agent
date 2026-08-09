// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import { useApprovalSettingsStore } from './approval-settings'
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
    const approval = useApprovalSettingsStore()
    const configuredProvider = provider()
    settings.providers = [configuredProvider]
    settings.activeProviderId = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id
    settings.providerForm.model = configuredProvider.model
    settings.providerForm.enabledModelIds = [
      ...configuredProvider.enabledModelIds,
    ]
    approval.approvalForm.providerId = configuredProvider.id
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
    expect(settings.allModelOptions.map((option) => option.value)).toEqual([
      'enabled-model',
      'catalog-only-model',
    ])
    expect(settings.modelTransferOptions.map((option) => option.value)).toEqual(
      ['catalog-only-model', 'enabled-model'],
    )
    expect(
      settings.modelTransferOptions.find(
        (option) => option.value === 'enabled-model',
      ),
    ).toMatchObject({ disabled: true })
    expect(settings.approvalModelOptions.map((option) => option.value)).toEqual(
      ['enabled-model'],
    )
    expect(settings.providerCardSummaries[0]?.models).toEqual(['enabled-model'])
  })

  it('allows any known model to become main and enables it atomically', () => {
    const settings = useAgentSettingsStore()
    settings.providerForm.model = 'enabled-model'
    settings.providerForm.enabledModelIds = ['enabled-model']
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

    settings.setProviderModel('catalog-only-model')

    expect(settings.providerForm.model).toBe('catalog-only-model')
    expect(settings.providerForm.enabledModelIds).toEqual([
      'enabled-model',
      'catalog-only-model',
    ])
    expect(
      settings.modelTransferOptions.find(
        (option) => option.value === 'catalog-only-model',
      ),
    ).toMatchObject({ disabled: true })
  })

  it('persists a manually entered model through the dedicated config action', async () => {
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
    const updatedProvider: ProviderPublicConfig = {
      ...configuredProvider,
      revision: configuredProvider.revision + 1,
      modelCatalog: [
        ...configuredProvider.modelCatalog,
        { id: 'manual-model' },
      ],
      enabledModelIds: [...configuredProvider.enabledModelIds, 'manual-model'],
    }
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        config: {
          activeProviderId: configuredProvider.id,
          providers: [updatedProvider],
        } as PublicConfig,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as Partial<AgentApi> as AgentApi,
    })

    await expect(settings.addProviderModel('  manual-model  ')).resolves.toBe(
      true,
    )
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'provider-model-add',
      providerId: configuredProvider.id,
      modelId: 'manual-model',
    })
    expect(settings.modelProfiles.map((model) => model.id)).toContain(
      'manual-model',
    )
    expect(settings.providerForm.enabledModelIds).toContain('manual-model')
  })

  it('keeps every enabled approval model visible regardless of annotation', () => {
    const settings = useAgentSettingsStore()
    const approval = useApprovalSettingsStore()
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
    approval.approvalForm.providerId = configuredProvider.id
    approval.approvalForm.reasoning = 'high'

    expect(settings.approvalModelOptions.map((option) => option.value)).toEqual(
      ['enabled-model', 'low-only-model', 'off-only-model'],
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
