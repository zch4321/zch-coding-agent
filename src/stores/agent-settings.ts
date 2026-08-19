import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  ModelCapabilityOverride,
  ModelCapabilityLevel,
  ProviderPublicConfig,
} from '../../shared/config/providers'
import {
  getProviderConfig,
  type PublicConfig,
} from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import type { ReasoningEffort } from '../../shared/reasoning'
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  resolveModelTokenSettings,
} from '../../shared/model-settings'
import type { UiModelProfile } from './agent-types'
import { useModelRolesStore } from './model-roles'
import { useModelPoolSettingsStore } from './model-pool-settings'
import {
  DEFAULT_PROVIDER_FORM,
  providerFormSignature,
  providerModelOverrides,
} from './provider-form'
import { useRuntimeSettingsStore } from './runtime-settings'

const providerSaveOperations = new WeakMap<object, Promise<boolean>>()

function providerModelProfiles(
  provider: ProviderPublicConfig | undefined,
  fallbackContextWindowTokens: number,
  compactTriggerPercent: number,
): UiModelProfile[] {
  if (!provider) return []

  const ids = new Set<string>(
    [
      provider.model,
      ...provider.modelCatalog.map((model) => model.id),
      ...Object.keys(provider.modelOverrides),
      ...provider.enabledModelIds,
    ].filter(Boolean),
  )

  return [...ids].map((id) => {
    const catalogModel = provider.modelCatalog.find((model) => model.id === id)
    const override = provider.modelOverrides[id]
    const contextWindowTokens =
      override?.contextWindowTokens ??
      catalogModel?.contextWindowTokens ??
      fallbackContextWindowTokens
    const tokenSettings = resolveModelTokenSettings({
      contextWindowTokens,
      maxOutputTokens:
        override?.maxOutputTokens ?? catalogModel?.maxOutputTokens,
      compactThresholdTokens: override?.compactThresholdTokens,
      compactTriggerPercent,
    })
    return {
      id,
      ownedBy: catalogModel?.ownedBy,
      availability: catalogModel ? 'provider' : 'custom',
      capabilitySource:
        override &&
        (override.contextWindowTokens !== undefined ||
          override.compactThresholdTokens !== undefined ||
          override.maxOutputTokens !== undefined)
          ? 'override'
          : catalogModel?.contextWindowTokens
            ? 'provider'
            : 'default',
      ...tokenSettings,
      ...(override?.reasoningEfforts?.length
        ? { reasoningEfforts: [...override.reasoningEfforts] }
        : {}),
      ...(override?.capability ? { capability: override.capability } : {}),
    }
  })
}

function providerPreviewModels(provider: ProviderPublicConfig): string[] {
  return provider.enabledModelIds.slice(0, 3)
}

/** Generates an opaque, immutable provider id; users never see or edit it. */
function newProviderId(): string {
  return `provider-${crypto.randomUUID()}`
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function limitsSignature(limits: PublicConfig['limits'] | undefined): string {
  return limits ? JSON.stringify(limits) : ''
}

function rebaseDerivedModelTokenSettings(
  models: UiModelProfile[],
  provider: ProviderPublicConfig | undefined,
  limits: PublicConfig['limits'],
): void {
  for (const model of models) {
    if (model.capabilitySource === 'override') continue
    const catalogModel = provider?.modelCatalog.find(
      (candidate) => candidate.id === model.id,
    )
    Object.assign(
      model,
      resolveModelTokenSettings({
        contextWindowTokens:
          catalogModel?.contextWindowTokens ?? limits.maxContextTokens,
        maxOutputTokens: catalogModel?.maxOutputTokens,
        compactTriggerPercent: limits.autoCompactTriggerPercent,
      }),
    )
    model.capabilitySource = catalogModel?.contextWindowTokens
      ? 'provider'
      : 'default'
  }
}

export const useProviderSettingsStore = defineStore('provider-settings', {
  state: () => ({
    error: '',
    selectedProviderId: 'deepseek',
    providers: [] as ProviderPublicConfig[],
    modelProfiles: [] as UiModelProfile[],
    modelCatalogFetchedAt: undefined as string | undefined,
    modelCatalogStale: true,
    modelCatalogLoading: false,
    pendingModelCatalogRefreshProviderId: undefined as string | undefined,
    providerForm: structuredClone(DEFAULT_PROVIDER_FORM),
    providerSavedSignature: providerFormSignature(DEFAULT_PROVIDER_FORM),
    providerSaving: false,
    providerSaveStatus: '',
  }),
  getters: {
    activeProvider: (state) =>
      state.providers.find(
        (provider) => provider.id === useModelRolesStore().defaultModelProvider,
      ),
    selectedProvider: (state) =>
      state.providers.find(
        (provider) => provider.id === state.selectedProviderId,
      ),
    credentialConfigured: (state) =>
      Boolean(
        state.providers.find(
          (provider) =>
            provider.id === useModelRolesStore().defaultModelProvider,
        )?.credentialConfigured,
      ),
    credentialSource: (state) =>
      state.providers.find(
        (provider) => provider.id === useModelRolesStore().defaultModelProvider,
      )?.credentialSource ?? 'none',
    selectedCredentialConfigured: (state) =>
      Boolean(
        state.providers.find(
          (provider) => provider.id === state.selectedProviderId,
        )?.credentialConfigured,
      ),
    selectedCredentialSource: (state) =>
      state.providers.find(
        (provider) => provider.id === state.selectedProviderId,
      )?.credentialSource ?? 'none',
    modelOptions: (state) => {
      const enabled = new Set(state.providerForm.enabledModelIds)
      return [...state.modelProfiles]
        .filter((model) => enabled.has(model.id))
        .sort((left, right) => {
          if (left.id === state.providerForm.model) return -1
          if (right.id === state.providerForm.model) return 1
          return left.id.localeCompare(right.id, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        })
        .map((model) => ({
          label: model.id,
          value: model.id,
        }))
    },
    allModelOptions: (state) =>
      [...state.modelProfiles]
        .sort((left, right) => {
          if (left.id === state.providerForm.model) return -1
          if (right.id === state.providerForm.model) return 1
          return left.id.localeCompare(right.id, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        })
        .map((model) => ({ label: model.id, value: model.id })),
    modelTransferOptions: (state) =>
      [...state.modelProfiles]
        .sort((left, right) =>
          left.id.localeCompare(right.id, undefined, {
            numeric: true,
            sensitivity: 'base',
          }),
        )
        .map((model) => ({
          label: model.id,
          value: model.id,
          disabled: model.id === state.providerForm.model,
        })),
    providerOptions: (state) =>
      state.providers.map((provider) => ({
        label: provider.label,
        value: provider.id,
        disabled:
          !provider.model || !provider.enabledModelIds.includes(provider.model),
      })),
    providerCardSummaries: (state) =>
      state.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        providerType: provider.providerType,
        models: providerPreviewModels(provider),
        isSelected: provider.id === state.selectedProviderId,
        credentialConfigured: provider.credentialConfigured,
        credentialSource: provider.credentialSource,
      })),
    activeModelProfile: (state) =>
      state.modelProfiles.find(
        (model) => model.id === state.providerForm.model,
      ),
    providerDirty: (state) =>
      Boolean(
        state.providerForm.apiKey.trim() ||
        providerFormSignature(state.providerForm, state.modelProfiles) !==
          state.providerSavedSignature,
      ),
    providerRefreshAvailable: (state) =>
      Boolean(
        state.providers.find(
          (provider) => provider.id === state.selectedProviderId,
        )?.credentialConfigured,
      ),
  },
  actions: {
    /** Hydrates the selected Provider draft and its complete model profiles. */
    hydrateSelectedProviderForm(config?: PublicConfig) {
      const providers = config?.models.providers ?? this.providers
      const defaultProviderId =
        config?.models.defaultModelProvider ??
        useModelRolesStore().defaultModelProvider
      const provider =
        providers.find((item) => item.id === this.selectedProviderId) ??
        providers.find((item) => item.id === defaultProviderId) ??
        providers[0]

      if (!provider) return

      this.selectedProviderId = provider.id
      this.providerForm.providerId = provider.id
      this.providerForm.label = provider.label
      this.providerForm.providerType = provider.providerType
      this.providerForm.baseURL = provider.baseURL
      this.providerForm.model = provider.model
      this.providerForm.enabledModelIds = [...provider.enabledModelIds]
      this.providerForm.apiKey = ''
      const limits = config?.limits ?? useRuntimeSettingsStore().limitsConfig
      this.modelProfiles = providerModelProfiles(
        provider,
        limits?.maxContextTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
        limits?.autoCompactTriggerPercent ?? 80,
      )
      this.modelCatalogFetchedAt = provider.modelCatalogFetchedAt
      this.modelCatalogStale =
        !provider.modelCatalogFetchedAt ||
        Date.now() - new Date(provider.modelCatalogFetchedAt).getTime() >
          24 * 60 * 60_000
    },
    /** Hydrates Provider-owned state when relevant config sections change. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      const includes = (section: ConfigSection) =>
        sections.includes('all') || sections.includes(section)
      const providerDraftWasDirty = this.providerDirty

      if (includes('providers')) {
        this.providers = structuredClone(config.models.providers)

        if (
          !this.selectedProviderId ||
          !getProviderConfig(config, this.selectedProviderId)
        ) {
          this.selectedProviderId = config.models.defaultModelProvider
        }
      }

      if (includes('providers')) {
        this.hydrateSelectedProviderForm(config)
        this.providerSavedSignature = providerFormSignature(
          this.providerForm,
          this.modelProfiles,
        )
      } else if (includes('limits')) {
        rebaseDerivedModelTokenSettings(
          this.modelProfiles,
          config.models.providers.find(
            (provider) => provider.id === this.selectedProviderId,
          ),
          config.limits,
        )
        if (!providerDraftWasDirty) {
          this.providerSavedSignature = providerFormSignature(
            this.providerForm,
            this.modelProfiles,
          )
        }
      }
    },
    /** Selects one Provider card for editing and optionally loads its catalog. */
    async selectProviderForEditing(providerId: string, refreshModels = true) {
      if (!this.providers.some((provider) => provider.id === providerId)) {
        return false
      }

      this.selectedProviderId = providerId
      this.hydrateSelectedProviderForm()
      this.providerSavedSignature = providerFormSignature(
        this.providerForm,
        this.modelProfiles,
      )
      if (refreshModels) await this.loadProviderModels(false)
      return true
    },
    /** Restores the selected Provider draft to its last persisted values. */
    resetSelectedProviderDraft() {
      this.hydrateSelectedProviderForm()
      this.providerSavedSignature = providerFormSignature(
        this.providerForm,
        this.modelProfiles,
      )
    },
    /** Selects a Provider default model and ensures it remains enabled. */
    setProviderModel(model: string) {
      this.providerForm.model = model
      if (!model) return

      if (!this.providerForm.enabledModelIds.includes(model)) {
        this.providerForm.enabledModelIds.push(model)
      }

      if (!this.modelProfiles.some((candidate) => candidate.id === model)) {
        const limits = useRuntimeSettingsStore().limitsConfig
        const fallbackContext =
          limits?.maxContextTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
        this.modelProfiles.push({
          id: model,
          availability: 'custom',
          capabilitySource: 'default',
          ...resolveModelTokenSettings({
            contextWindowTokens: fallbackContext,
            compactTriggerPercent: limits?.autoCompactTriggerPercent ?? 80,
          }),
        })
        this.modelProfiles.sort((left, right) =>
          left.id.localeCompare(right.id),
        )
      }
    },
    /** Persists one manually configured model and enables it for runtime selection. */
    async addProviderModel(input: {
      modelId: string
      modelOverride: ModelCapabilityOverride
    }): Promise<boolean> {
      const bridge = window.agentApi
      const normalizedModelId = input.modelId.trim()
      if (!bridge || !normalizedModelId) return false
      if (this.providerDirty && !(await this.saveProvider())) return false

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-model-add',
        providerId: this.selectedProviderId,
        modelId: normalizedModelId,
        modelOverride: cloneJson(input.modelOverride),
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.applyConfig(result.value.config, ['providers'])
      return true
    },
    /** Deletes one non-active model from the selected Provider configuration. */
    async deleteProviderModel(modelId: string): Promise<boolean> {
      const bridge = window.agentApi
      const normalizedModelId = modelId.trim()
      if (!bridge || !normalizedModelId) return false
      if (this.providerDirty && !(await this.saveProvider())) return false

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-model-delete',
        providerId: this.selectedProviderId,
        modelId: normalizedModelId,
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.applyConfig(result.value.config, ['providers'])
      useModelPoolSettingsStore().applyExternalConfig(result.value.config)
      return true
    },
    /** Updates one model row while preserving a usable prompt budget. */
    updateModelConfiguration(
      modelId: string,
      field:
        | 'contextWindowTokens'
        | 'compactThresholdTokens'
        | 'maxOutputTokens',
      value: number | null,
    ) {
      if (value === null || !Number.isInteger(value)) return
      const model = this.modelProfiles.find(
        (candidate) => candidate.id === modelId,
      )
      if (!model) return

      if (field === 'contextWindowTokens') {
        model.contextWindowTokens = Math.min(10_000_000, Math.max(2_048, value))
      } else if (field === 'maxOutputTokens') {
        model.maxOutputTokens = Math.min(
          Math.max(1, model.contextWindowTokens - 1_024),
          Math.max(1, value),
        )
      } else {
        model.compactThresholdTokens = Math.max(1_024, value)
      }

      Object.assign(
        model,
        resolveModelTokenSettings({
          contextWindowTokens: model.contextWindowTokens,
          compactThresholdTokens: model.compactThresholdTokens,
          maxOutputTokens: model.maxOutputTokens,
          compactTriggerPercent:
            useRuntimeSettingsStore().limitsConfig?.autoCompactTriggerPercent ??
            80,
        }),
      )
      model.capabilitySource = 'override'
    },
    /**
     * Updates per-model reasoning/capability annotation. Clearing an annotation
     * removes the field; token override semantics (capabilitySource) are untouched.
     */
    updateModelAnnotation(
      modelId: string,
      patch: {
        reasoningEfforts?: ReasoningEffort[]
        capability?: ModelCapabilityLevel | null
      },
    ) {
      const model = this.modelProfiles.find(
        (candidate) => candidate.id === modelId,
      )
      if (!model) return

      if (patch.reasoningEfforts !== undefined) {
        if (patch.reasoningEfforts.length) {
          model.reasoningEfforts = [...patch.reasoningEfforts]
        } else {
          delete model.reasoningEfforts
        }
      }
      if (patch.capability !== undefined) {
        if (patch.capability) {
          model.capability = patch.capability
        } else {
          delete model.capability
        }
      }
    },
    /** Loads cached profiles or refreshes the saved Provider model catalog. */
    async loadProviderModels(
      refresh: boolean,
      reportError = refresh,
      requestedProviderId?: string,
    ) {
      const bridge = window.agentApi

      if (!bridge) return false
      if (this.modelCatalogLoading) {
        if (refresh) {
          this.pendingModelCatalogRefreshProviderId =
            requestedProviderId ?? this.selectedProviderId
        }
        return false
      }
      this.modelCatalogLoading = true
      const providerId = requestedProviderId ?? this.selectedProviderId
      const draftSignature =
        providerId === this.selectedProviderId
          ? providerFormSignature(this.providerForm, this.modelProfiles)
          : ''

      try {
        const result = await bridge.listProviderModels({
          version: IPC_VERSION,
          refresh,
          providerId,
        })
        if (!result.ok) {
          if (reportError) this.error = result.error.message
          return false
        }

        if (refresh) {
          const configResult = await bridge.getConfig({
            version: IPC_VERSION,
            section: 'providers',
          })
          if (configResult.ok) {
            const refreshedProvider =
              configResult.value.config.models.providers.find(
                (provider) => provider.id === providerId,
              )
            const providerIndex = this.providers.findIndex(
              (provider) => provider.id === providerId,
            )
            if (refreshedProvider && providerIndex >= 0) {
              this.providers.splice(
                providerIndex,
                1,
                structuredClone(refreshedProvider),
              )
            }
          }
        }

        if (providerId !== this.selectedProviderId) return true
        if (
          providerFormSignature(this.providerForm, this.modelProfiles) !==
          draftSignature
        ) {
          return true
        }
        const draftWasPersisted = this.providerSavedSignature === draftSignature
        this.modelProfiles = result.value.models
        this.modelCatalogFetchedAt = result.value.fetchedAt
        this.modelCatalogStale = result.value.stale
        if (draftWasPersisted) {
          this.providerSavedSignature = providerFormSignature(
            this.providerForm,
            this.modelProfiles,
          )
        }
        return true
      } finally {
        this.modelCatalogLoading = false
        const pendingProviderId = this.pendingModelCatalogRefreshProviderId
        this.pendingModelCatalogRefreshProviderId = undefined
        if (pendingProviderId) {
          void this.loadProviderModels(true, true, pendingProviderId)
        }
      }
    },
    /** Refreshes the selected saved Provider when its settings page opens. */
    async loadSelectedProviderModelsOnEntry() {
      return this.loadProviderModels(this.providerRefreshAvailable, false)
    },
    /** Starts the Provider-page model discovery attempt for the selected card. */
    async enterProviderSettings() {
      return this.loadSelectedProviderModelsOnEntry()
    },
    /** Flushes Provider edits, then explicitly refreshes its model catalog. */
    async refreshSelectedProviderModels() {
      if (this.providerDirty && !(await this.saveProvider())) return false
      if (!this.providerRefreshAvailable) {
        this.error = 'Save a Provider credential before refreshing models.'
        return false
      }
      this.error = ''
      return this.loadProviderModels(true)
    },
    /** Creates an empty generic Provider using the current runtime limits. */
    async createProvider() {
      const bridge = window.agentApi
      if (!bridge) return false

      const limits = useRuntimeSettingsStore().limitsConfig
      if (!limits) {
        this.error = 'Provider settings are not initialized.'
        return false
      }

      const labelBase = 'New Provider'
      const nextIndex = this.providers.length + 1
      const label = `${labelBase} ${nextIndex}`
      const providerId = newProviderId()
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-settings',
        providerId,
        label,
        providerType: 'generic.chat-completions',
        baseURL: 'https://api.example.com/v1',
        model: '',
        enabledModelIds: [],
        limits: cloneJson(limits),
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.selectedProviderId = providerId
      this.applyConfig(result.value.config, ['providers', 'limits'])
      return true
    },
    /** Copies a Provider into a new independently editable configuration. */
    async copyProvider(sourceProviderId?: string) {
      const bridge = window.agentApi
      const sourceId = sourceProviderId ?? this.selectedProviderId
      const source = this.providers.find((provider) => provider.id === sourceId)
      if (!bridge || !source) return false

      const providerId = newProviderId()
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-copy',
        sourceProviderId: source.id,
        providerId,
        label: `${source.label} Copy`,
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.selectedProviderId = providerId
      this.applyConfig(result.value.config, ['providers'])
      return true
    },
    /** Deletes one Provider and reconciles dependent model routes. */
    async deleteProvider(providerId: string) {
      const bridge = window.agentApi
      if (!bridge || this.providers.length <= 1) return false

      const fallbackProvider = this.providers.find(
        (provider) => provider.id !== providerId,
      )
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-delete',
        providerId,
        ...(fallbackProvider
          ? { fallbackProviderId: fallbackProvider.id }
          : {}),
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      if (this.selectedProviderId === providerId) {
        this.selectedProviderId =
          result.value.config.models.defaultModelProvider
      }
      this.applyConfig(result.value.config, ['providers'])
      useModelRolesStore().applyConfig(result.value.config, ['models'])
      useModelPoolSettingsStore().applyExternalConfig(result.value.config)
      return true
    },
    /** Persists Provider drafts serially while preserving edits made in flight. */
    async saveProvider(): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge) return false

      const activeOperation = providerSaveOperations.get(this)
      if (activeOperation) {
        const saved = await activeOperation
        return saved && this.providerDirty ? this.saveProvider() : saved
      }

      const operation = (async (): Promise<boolean> => {
        this.error = ''
        this.providerSaveStatus = ''
        this.providerSaving = true
        const providersToRefresh = new Set<string>()

        try {
          while (this.providerDirty) {
            const runtimeSettings = useRuntimeSettingsStore()
            const limits = runtimeSettings.limitsConfig
            if (!limits) {
              this.error = 'Provider settings are not initialized.'
              return false
            }

            const draft = cloneJson(this.providerForm)
            const draftProfiles = cloneJson(this.modelProfiles)
            const draftSignature = providerFormSignature(draft, draftProfiles)
            const apiKey = draft.apiKey.trim()
            const persistedProvider = this.providers.find(
              (provider) => provider.id === draft.providerId,
            )
            const catalogIdentityChanged = Boolean(
              persistedProvider?.credentialConfigured &&
              (persistedProvider.baseURL !== draft.baseURL ||
                persistedProvider.providerType !== draft.providerType),
            )
            const limitsDraft = cloneJson(limits)
            const limitsDraftSignature = limitsSignature(limitsDraft)
            const saved = await bridge.setConfig({
              version: IPC_VERSION,
              kind: 'provider-settings',
              baseURL: draft.baseURL,
              model: draft.model,
              enabledModelIds: draft.enabledModelIds,
              modelOverrides: providerModelOverrides(draftProfiles),
              providerId: draft.providerId,
              label: draft.label,
              providerType: draft.providerType,
              limits: limitsDraft,
              ...(apiKey ? { apiKey } : {}),
            })
            if (!saved.ok) {
              this.error = saved.error.message
              this.providerSaveStatus = saved.error.message
              return false
            }

            const currentSignature = providerFormSignature(
              this.providerForm,
              this.modelProfiles,
            )
            const apiKeyUnchanged = this.providerForm.apiKey === draft.apiKey
            this.providers = structuredClone(
              saved.value.config.models.providers,
            )
            useModelRolesStore().applyConfig(saved.value.config, ['models'])
            useModelPoolSettingsStore().applyExternalConfig(saved.value.config)
            if (
              limitsSignature(runtimeSettings.limitsConfig) ===
              limitsDraftSignature
            ) {
              runtimeSettings.applyConfig(saved.value.config, ['limits'])
            }

            if (this.selectedProviderId === draft.providerId) {
              this.providerSavedSignature = draftSignature
              if (currentSignature === draftSignature && apiKeyUnchanged) {
                this.hydrateSelectedProviderForm(saved.value.config)
                this.providerSavedSignature = providerFormSignature(
                  this.providerForm,
                  this.modelProfiles,
                )
              } else if (apiKeyUnchanged) {
                this.providerForm.apiKey = ''
              }
            }

            if (apiKey || catalogIdentityChanged) {
              providersToRefresh.add(draft.providerId)
            }
            this.providerSaveStatus = 'Saved'
            if (this.selectedProviderId !== draft.providerId) break
          }
          return true
        } finally {
          this.providerSaving = false
          for (const providerId of providersToRefresh) {
            void this.loadProviderModels(true, true, providerId)
          }
        }
      })()
      const trackedOperation = operation.finally(() => {
        providerSaveOperations.delete(this)
      })
      providerSaveOperations.set(this, trackedOperation)
      return trackedOperation
    },
    /** Clears the selected Provider credential and reconciles dependent routes. */
    async clearCredential() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'credential',
        providerId: this.selectedProviderId,
        action: 'clear',
      })
      if (result.ok) {
        this.applyConfig(result.value.config, ['providers'])
        useModelPoolSettingsStore().applyExternalConfig(result.value.config)
      } else this.error = result.error.message
    },
  },
})
