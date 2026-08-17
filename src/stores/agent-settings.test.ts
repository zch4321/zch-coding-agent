// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type {
  ConfigSetRequest,
  ModelCapabilityOverride,
  ProviderPublicConfig,
  PublicConfig,
} from '../../shared/config'
import { useModelRolesStore } from './model-roles'
import { useAgentSettingsStore } from './agent-settings'
import { useModelPoolSettingsStore } from './model-pool-settings'
import { providerFormSignature } from './provider-form'

function provider(): ProviderPublicConfig {
  return {
    id: 'provider-a',
    label: 'Provider A',
    providerType: 'generic.chat-completions',
    revision: 1,
    baseURL: 'https://provider.example/v1',
    model: 'enabled-model',
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
    useModelRolesStore().defaultModelProvider = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id
    settings.providerForm.model = configuredProvider.model
    settings.providerForm.enabledModelIds = [
      ...configuredProvider.enabledModelIds,
    ]
    useModelRolesStore().auxiliaryModelProvider = configuredProvider.id
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
    expect(settings.providerCardSummaries[0]?.models).toEqual(['enabled-model'])
  })

  it('loads discovered command Shells and persists the user selection', async () => {
    const settings = useAgentSettingsStore()
    const profile = {
      id: 'powershell-7' as const,
      kind: 'powershell' as const,
      label: 'PowerShell 7',
      executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      source: 'well-known' as const,
    }
    const listCommandShells = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        selected: 'powershell-7' as const,
        resolved: profile,
        fallback: false,
        profiles: [profile],
      },
    }))
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        config: {
          executionEnvironment: { commandShell: 'powershell-7' },
        } as PublicConfig,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listCommandShells,
        setConfig,
      } as Partial<AgentApi> as AgentApi,
    })

    await expect(settings.loadCommandShells(true)).resolves.toBe(true)
    expect(listCommandShells).toHaveBeenCalledWith({
      version: 1,
      refresh: true,
    })
    expect(settings.commandShellCatalog?.resolved.id).toBe('powershell-7')

    await expect(settings.setCommandShell('powershell-7')).resolves.toBe(true)
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'execution-environment',
      value: { commandShell: 'powershell-7' },
    })
    expect(settings.executionEnvironmentConfig.commandShell).toBe(
      'powershell-7',
    )
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
    const modelOverride: ModelCapabilityOverride = {
      contextWindowTokens: 400_000,
      compactThresholdTokens: 250_000,
      maxOutputTokens: 50_000,
      reasoningEfforts: ['low', 'high'],
      capability: 'strong',
    }
    settings.providers = [configuredProvider]
    useModelRolesStore().defaultModelProvider = configuredProvider.id
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
      modelOverrides: {
        ...configuredProvider.modelOverrides,
        'manual-model': modelOverride,
      },
    }
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        config: {
          models: {
            defaultModelProvider: configuredProvider.id,
            defaultModel: updatedProvider.model,
            auxiliaryModelProvider: '',
            auxiliaryModel: '',
            providers: [updatedProvider],
            modelPool: { entries: [] },
          },
        } as unknown as PublicConfig,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as Partial<AgentApi> as AgentApi,
    })

    await expect(
      settings.addProviderModel({
        modelId: '  manual-model  ',
        modelOverride,
      }),
    ).resolves.toBe(true)
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'provider-model-add',
      providerId: configuredProvider.id,
      modelId: 'manual-model',
      modelOverride,
    })
    expect(settings.modelProfiles.map((model) => model.id)).toContain(
      'manual-model',
    )
    expect(settings.providerForm.enabledModelIds).toContain('manual-model')
    expect(
      settings.modelProfiles.find((model) => model.id === 'manual-model'),
    ).toMatchObject({
      ...modelOverride,
      capabilitySource: 'override',
    })
  })

  it('deletes a model through the dedicated config action', async () => {
    const settings = useAgentSettingsStore()
    const pool = useModelPoolSettingsStore()
    const configuredProvider = provider()
    settings.providers = [configuredProvider]
    useModelRolesStore().defaultModelProvider = configuredProvider.id
    settings.selectedProviderId = configuredProvider.id
    settings.hydrateSelectedProviderForm()
    settings.providerSavedSignature = providerFormSignature(
      settings.providerForm,
      settings.modelProfiles,
    )
    const updatedProvider: ProviderPublicConfig = {
      ...configuredProvider,
      modelCatalog: configuredProvider.modelCatalog.filter(
        (model) => model.id !== 'catalog-only-model',
      ),
    }
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        config: {
          models: {
            defaultModelProvider: configuredProvider.id,
            defaultModel: updatedProvider.model,
            auxiliaryModelProvider: '',
            auxiliaryModel: '',
            providers: [updatedProvider],
            modelPool: {
              entries: [
                {
                  id: 'worker-1',
                  enabled: false,
                  providerId: configuredProvider.id,
                  model: 'catalog-only-model',
                  reasoning: 'off',
                },
              ],
            },
          },
        } as unknown as PublicConfig,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as Partial<AgentApi> as AgentApi,
    })

    await expect(
      settings.deleteProviderModel('  catalog-only-model  '),
    ).resolves.toBe(true)

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'provider-model-delete',
      providerId: configuredProvider.id,
      modelId: 'catalog-only-model',
    })
    expect(settings.modelProfiles.map((model) => model.id)).not.toContain(
      'catalog-only-model',
    )
    expect(pool.entries).toEqual([
      expect.objectContaining({
        model: 'catalog-only-model',
        enabled: false,
      }),
    ])
  })

  it('keeps an unsaved Provider draft dirty after loading its model catalog', async () => {
    const settings = useAgentSettingsStore()
    const configuredProvider = provider()
    settings.providers = [configuredProvider]
    useModelRolesStore().defaultModelProvider = configuredProvider.id
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
    useModelRolesStore().defaultModelProvider = configuredProvider.id
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

  it('persists the global default mode and follows edits made during a save', async () => {
    const settings = useAgentSettingsStore()
    settings.applyConfig(
      {
        permission: {
          defaultMode: 'readonly',
          builtinPolicies: true,
          rememberedRules: [],
          sensitiveData: {
            mode: 'confirm',
            pathGlobs: [],
            contentPatterns: [],
          },
        },
      } as unknown as PublicConfig,
      ['permission'],
    )

    type SetConfigResult = Awaited<ReturnType<AgentApi['setConfig']>>
    let resolveFirst!: (result: SetConfigResult) => void
    const responseFor = (
      request: Extract<ConfigSetRequest, { kind: 'permission' }>,
    ): SetConfigResult => ({
      version: 1,
      ok: true,
      value: {
        config: {
          permission: {
            defaultMode: request.defaultMode,
            builtinPolicies: request.builtinPolicies,
            rememberedRules: request.rememberedRules,
            sensitiveData: request.sensitiveData,
          },
        } as PublicConfig,
      },
    })
    const setConfig = vi.fn((request: ConfigSetRequest) => {
      if (request.kind !== 'permission') {
        throw new Error('Expected a permission config request')
      }
      const response = responseFor(request)
      if (setConfig.mock.calls.length === 1) {
        return new Promise<SetConfigResult>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(response)
    })
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as Partial<AgentApi> as AgentApi,
    })

    settings.defaultMode = 'auto'
    const saving = settings.savePermissions()
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    const firstRequest = setConfig.mock.calls[0]![0]
    if (firstRequest.kind !== 'permission') {
      throw new Error('Expected a permission config request')
    }

    settings.defaultMode = 'confirm'
    settings.permissionForm.pathGlobs = 'src/**'
    resolveFirst(responseFor(firstRequest))

    await expect(saving).resolves.toBe(true)
    expect(setConfig).toHaveBeenCalledTimes(2)
    expect(setConfig.mock.calls[1]?.[0]).toMatchObject({
      kind: 'permission',
      defaultMode: 'confirm',
      sensitiveData: { pathGlobs: ['src/**'] },
    })
    expect(settings.defaultMode).toBe('confirm')
    expect(settings.permissionForm.pathGlobs).toBe('src/**')
    expect(settings.permissionsDirty).toBe(false)
  })
})
