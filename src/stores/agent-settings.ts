import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AssistantLanguage,
  ConfigSection,
  ModelCapabilityOverride,
  ModelCapabilityLevel,
  PermissionMode,
  ProviderPublicConfig,
  PublicConfig,
  ReasoningEffort,
} from '../../shared/config'
import { getProviderConfig } from '../../shared/config'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
  YOLO_NOTICE_VERSION,
} from '../../shared/notices'
import { DEFAULT_ASSISTANT_PREFERENCES } from '../../shared/system-prompts'
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  resolveModelTokenSettings,
} from '../../shared/model-settings'
import { nowNotice, toUiRememberedRules } from './config-mapping'
import type {
  CommandShellCatalog,
  CommandShellSelection,
} from '../../shared/command-shell'
import type { UiModelProfile, UiRememberedRule } from './agent-types'
import { useApprovalSettingsStore } from './approval-settings'
import { useModelPoolSettingsStore } from './model-pool-settings'
import {
  DEFAULT_PROVIDER_FORM,
  providerFormSignature,
  providerModelOverrides,
} from './provider-form'

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

function providerIdFromLabel(label: string, existingIds: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'provider'
  let candidate = base
  let index = 2

  while (existingIds.has(candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }

  return candidate
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function limitsSignature(limits: PublicConfig['limits'] | undefined): string {
  return limits ? JSON.stringify(limits) : ''
}

function subagentsSignature(
  subagents: PublicConfig['subagents'] | undefined,
): string {
  return subagents ? JSON.stringify(subagents) : ''
}

export const useAgentSettingsStore = defineStore('agent-settings', {
  state: () => ({
    error: '',
    providerNoticeVersion: '',
    traceNoticeVersion: '',
    yoloNoticeVersion: '',
    activeProviderId: 'deepseek',
    selectedProviderId: 'deepseek',
    providers: [] as ProviderPublicConfig[],
    builtinPolicies: true,
    rememberedRules: [] as UiRememberedRule[],
    defaultMode: 'readonly' as PermissionMode,
    modelProfiles: [] as UiModelProfile[],
    modelCatalogFetchedAt: undefined as string | undefined,
    modelCatalogStale: true,
    modelCatalogLoading: false,
    pendingModelCatalogRefreshProviderId: undefined as string | undefined,
    limitsConfig: undefined as PublicConfig['limits'] | undefined,
    limitsSavedSignature: '',
    limitsSaving: false,
    limitsSaveStatus: '',
    subagentsConfig: undefined as PublicConfig['subagents'] | undefined,
    subagentsSavedSignature: '',
    subagentsSaving: false,
    subagentsSaveStatus: '',
    executionEnvironmentConfig: {
      commandShell: 'auto',
    } as PublicConfig['executionEnvironment'],
    commandShellCatalog: undefined as CommandShellCatalog | undefined,
    commandShellLoading: false,
    commandShellSaving: false,
    commandShellSaveStatus: '',
    providerForm: structuredClone(DEFAULT_PROVIDER_FORM),
    providerSavedSignature: providerFormSignature(DEFAULT_PROVIDER_FORM),
    providerSaving: false,
    providerSaveStatus: '',
    permissionForm: {
      sensitiveMode: 'confirm' as 'off' | 'warn' | 'confirm',
      pathGlobs: '',
      contentPatterns: '',
    },
    loggingForm: {
      enabled: false,
      retentionDays: 14,
      maxTotalMegabytes: 100,
    },
    loggingWarnings: [] as string[],
    assistantForm: {
      language: 'zh-CN' as AssistantLanguage,
      preferences: structuredClone(DEFAULT_ASSISTANT_PREFERENCES),
    },
    assistantSaving: false,
    assistantSaveStatus: '',
    webSearchForm: {
      provider: 'brave' as PublicConfig['webSearch']['provider'],
      count: 5,
      apiKey: '',
    },
    webSearchCredentialConfigured: false,
    webSearchSaving: false,
    webSearchSaveStatus: '',
    webSearchSavedSignature: 'brave|5',
  }),
  getters: {
    providerNoticeAccepted: (state) =>
      state.providerNoticeVersion === PROVIDER_NOTICE_VERSION,
    traceNoticeAccepted: (state) =>
      state.traceNoticeVersion === TRACE_NOTICE_VERSION,
    yoloNoticeAccepted: (state) =>
      state.yoloNoticeVersion === YOLO_NOTICE_VERSION,
    activeProvider: (state) =>
      state.providers.find(
        (provider) => provider.id === state.activeProviderId,
      ),
    selectedProvider: (state) =>
      state.providers.find(
        (provider) => provider.id === state.selectedProviderId,
      ),
    credentialConfigured: (state) =>
      Boolean(
        state.providers.find(
          (provider) => provider.id === state.activeProviderId,
        )?.credentialConfigured,
      ),
    credentialSource: (state) =>
      state.providers.find((provider) => provider.id === state.activeProviderId)
        ?.credentialSource ?? 'none',
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
    approvalModelOptions: (state) => {
      const approval = useApprovalSettingsStore()
      const provider = state.providers.find(
        (candidate) => candidate.id === approval.approvalForm.providerId,
      )
      if (!provider) return []
      return provider.enabledModelIds.map((id) => ({ label: id, value: id }))
    },
    providerCardSummaries: (state) =>
      state.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        providerType: provider.providerType,
        models: providerPreviewModels(provider),
        isActive: provider.id === state.activeProviderId,
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
    limitsDirty: (state) =>
      limitsSignature(state.limitsConfig) !== state.limitsSavedSignature,
    subagentsDirty: (state) =>
      subagentsSignature(state.subagentsConfig) !==
      state.subagentsSavedSignature,
    webSearchDirty: (state) =>
      Boolean(
        state.webSearchForm.apiKey.trim() ||
        `${state.webSearchForm.provider}|${state.webSearchForm.count}` !==
          state.webSearchSavedSignature,
      ),
  },
  actions: {
    hydrateSelectedProviderForm(config?: PublicConfig) {
      const providers = config?.providers ?? this.providers
      const activeProviderId = config?.activeProviderId ?? this.activeProviderId
      const provider =
        providers.find((item) => item.id === this.selectedProviderId) ??
        providers.find((item) => item.id === activeProviderId) ??
        providers[0]

      if (!provider) return

      this.selectedProviderId = provider.id
      this.providerForm.providerId = provider.id
      this.providerForm.label = provider.label
      this.providerForm.providerType = provider.providerType
      this.providerForm.baseURL = provider.baseURL
      this.providerForm.model = provider.model
      this.providerForm.enabledModelIds = [...provider.enabledModelIds]
      this.providerForm.reasoning = provider.reasoning
      this.providerForm.apiKey = ''
      const limits = config?.limits ?? this.limitsConfig
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

      if (limits) {
        this.providerForm.tokenEstimationMode = limits.tokenEstimation.mode
        this.providerForm.bytesPerToken = limits.tokenEstimation.bytesPerToken
      }
    },
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      const includes = (section: ConfigSection) =>
        sections.includes('all') || sections.includes(section)

      if (includes('privacy')) {
        this.providerNoticeVersion =
          config.privacy.providerNoticeAccepted?.version ?? ''
        this.traceNoticeVersion =
          config.privacy.traceNoticeAccepted?.version ?? ''
        this.yoloNoticeVersion =
          config.privacy.yoloNoticeAccepted?.version ?? ''
      }

      if (includes('providers')) {
        this.activeProviderId = config.activeProviderId
        this.providers = structuredClone(config.providers)

        if (
          !this.selectedProviderId ||
          !getProviderConfig(config, this.selectedProviderId)
        ) {
          this.selectedProviderId = config.activeProviderId
        }
      }

      if (includes('limits')) {
        this.limitsConfig = structuredClone(config.limits)
        this.limitsSavedSignature = limitsSignature(config.limits)
        this.providerForm.tokenEstimationMode =
          config.limits.tokenEstimation.mode
        this.providerForm.bytesPerToken =
          config.limits.tokenEstimation.bytesPerToken
      }

      if (includes('subagents')) {
        this.subagentsConfig = structuredClone(config.subagents)
        this.subagentsSavedSignature = subagentsSignature(config.subagents)
      }

      if (includes('executionEnvironment')) {
        this.executionEnvironmentConfig = structuredClone(
          config.executionEnvironment,
        )
      }

      if (includes('providers') || includes('limits')) {
        this.hydrateSelectedProviderForm(config)
        this.providerSavedSignature = providerFormSignature(
          this.providerForm,
          this.modelProfiles,
        )
      }

      if (includes('permission')) {
        this.defaultMode = config.permission.defaultMode
        this.builtinPolicies = config.permission.builtinPolicies
        this.rememberedRules = toUiRememberedRules(config)
        this.permissionForm.sensitiveMode = config.permission.sensitiveData.mode
        this.permissionForm.pathGlobs =
          config.permission.sensitiveData.pathGlobs.join('\n')
        this.permissionForm.contentPatterns =
          config.permission.sensitiveData.contentPatterns.join('\n')
      }

      if (includes('logging')) {
        this.loggingForm.enabled = config.logging.enabled
        this.loggingForm.retentionDays = config.logging.retentionDays
        this.loggingForm.maxTotalMegabytes = Math.max(
          1,
          Math.round(config.logging.maxTotalBytes / 1_000_000),
        )
      }

      if (includes('assistant')) {
        this.assistantForm = structuredClone(config.assistant)
      }

      if (includes('all') || includes('webSearch')) {
        this.webSearchForm.provider = config.webSearch.provider
        this.webSearchForm.count = config.webSearch.count
        this.webSearchForm.apiKey = ''
        this.webSearchCredentialConfigured =
          config.webSearch.credentialConfigured
        this.webSearchSavedSignature = `${config.webSearch.provider}|${config.webSearch.count}`
      }
    },
    async saveAssistantSettings(language?: AssistantLanguage) {
      const bridge = window.agentApi
      const targetLanguage = language ?? this.assistantForm.language

      if (!bridge) {
        this.assistantForm.language = targetLanguage
        return true
      }

      this.assistantSaving = true
      this.assistantSaveStatus = ''
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'assistant',
        value: {
          language: targetLanguage,
          preferences: {
            'zh-CN': this.assistantForm.preferences['zh-CN'].trim(),
            'en-US': this.assistantForm.preferences['en-US'].trim(),
          },
        },
      })
      this.assistantSaving = false

      if (!result.ok) {
        this.error = result.error.message
        this.assistantSaveStatus = result.error.message
        return false
      }

      this.applyConfig(result.value.config, ['assistant'])
      this.assistantSaveStatus = 'saved'
      return true
    },
    async loadCommandShells(refresh = false): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge || this.commandShellLoading) return false
      this.commandShellLoading = true
      this.commandShellSaveStatus = ''
      try {
        const result = await bridge.listCommandShells({
          version: IPC_VERSION,
          ...(refresh ? { refresh: true } : {}),
        })
        if (!result.ok) {
          this.error = result.error.message
          this.commandShellSaveStatus = result.error.message
          return false
        }
        this.commandShellCatalog = structuredClone(result.value)
        return true
      } finally {
        this.commandShellLoading = false
      }
    },
    async setCommandShell(
      commandShell: CommandShellSelection,
    ): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge || this.commandShellSaving) return false
      const previous = this.executionEnvironmentConfig.commandShell
      this.executionEnvironmentConfig.commandShell = commandShell
      this.commandShellSaving = true
      this.commandShellSaveStatus = ''
      try {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'execution-environment',
          value: { commandShell },
        })
        if (!result.ok) {
          this.executionEnvironmentConfig.commandShell = previous
          this.error = result.error.message
          this.commandShellSaveStatus = result.error.message
          return false
        }
        this.applyConfig(result.value.config, ['executionEnvironment'])
        if (await this.loadCommandShells()) {
          this.commandShellSaveStatus = 'Saved'
        }
        return true
      } finally {
        this.commandShellSaving = false
      }
    },
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
    resetSelectedProviderDraft() {
      this.hydrateSelectedProviderForm()
      this.providerSavedSignature = providerFormSignature(
        this.providerForm,
        this.modelProfiles,
      )
    },
    setProviderModel(model: string) {
      this.providerForm.model = model
      if (!model) return

      if (!this.providerForm.enabledModelIds.includes(model)) {
        this.providerForm.enabledModelIds.push(model)
      }

      if (!this.modelProfiles.some((candidate) => candidate.id === model)) {
        const fallbackContext =
          this.limitsConfig?.maxContextTokens ??
          DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
        this.modelProfiles.push({
          id: model,
          availability: 'custom',
          capabilitySource: 'default',
          ...resolveModelTokenSettings({
            contextWindowTokens: fallbackContext,
            compactTriggerPercent:
              this.limitsConfig?.autoCompactTriggerPercent ?? 80,
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
            this.limitsConfig?.autoCompactTriggerPercent ?? 80,
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
            const refreshedProvider = configResult.value.config.providers.find(
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
    async setActiveProvider(providerId: string) {
      const bridge = window.agentApi
      if (!bridge) return false

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-select',
        providerId,
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.applyConfig(result.value.config, ['providers'])
      return true
    },
    async createProvider() {
      const bridge = window.agentApi
      if (!bridge) return false

      const limits = this.limitsConfig
      if (!limits) {
        this.error = 'Provider settings are not initialized.'
        return false
      }

      const existingIds = new Set(this.providers.map((provider) => provider.id))
      const labelBase = 'New Provider'
      const nextIndex = this.providers.length + 1
      const label = `${labelBase} ${nextIndex}`
      const providerId = providerIdFromLabel(label, existingIds)
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider-settings',
        providerId,
        label,
        providerType: 'generic.chat-completions',
        baseURL: 'https://api.example.com/v1',
        model: '',
        enabledModelIds: [],
        reasoning: 'off',
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
    async copyProvider(sourceProviderId?: string) {
      const bridge = window.agentApi
      const sourceId = sourceProviderId ?? this.selectedProviderId
      const source = this.providers.find((provider) => provider.id === sourceId)
      if (!bridge || !source) return false

      const providerId = providerIdFromLabel(
        `${source.label} copy`,
        new Set(this.providers.map((provider) => provider.id)),
      )
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
        this.selectedProviderId = result.value.config.activeProviderId
      }
      this.applyConfig(result.value.config, ['providers'])
      useApprovalSettingsStore().applyConfig(result.value.config, ['approval'])
      useModelPoolSettingsStore().applyExternalConfig(result.value.config)
      return true
    },
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
            const limits = this.limitsConfig
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
              reasoning: draft.reasoning,
              providerId: draft.providerId,
              label: draft.label,
              providerType: draft.providerType,
              limits: {
                ...limitsDraft,
                tokenEstimation: {
                  mode: draft.tokenEstimationMode,
                  bytesPerToken: draft.bytesPerToken,
                },
              },
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
            this.activeProviderId = saved.value.config.activeProviderId
            this.providers = structuredClone(saved.value.config.providers)
            useModelPoolSettingsStore().applyExternalConfig(saved.value.config)
            if (limitsSignature(this.limitsConfig) === limitsDraftSignature) {
              this.limitsConfig = structuredClone(saved.value.config.limits)
              this.limitsSavedSignature = limitsSignature(
                saved.value.config.limits,
              )
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
    async saveWebSearchSettings() {
      const bridge = window.agentApi
      if (!bridge) return
      this.webSearchSaving = true
      try {
        const apiKey = this.webSearchForm.apiKey.trim()
        if (apiKey) {
          const keyResult = await bridge.setConfig({
            version: IPC_VERSION,
            kind: 'web-search-credential',
            action: 'set',
            apiKey,
          })
          if (!keyResult.ok) {
            this.error = keyResult.error.message
            return false
          }
          this.applyConfig(keyResult.value.config, ['webSearch'])
        }

        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'web-search',
          provider: this.webSearchForm.provider,
          count: this.webSearchForm.count,
        })
        if (result.ok) {
          this.applyConfig(result.value.config, ['webSearch'])
          this.webSearchSaveStatus = 'saved'
          return true
        }
        this.error = result.error.message
        return false
      } finally {
        this.webSearchSaving = false
      }
    },
    async clearWebSearchCredential() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'web-search-credential',
        action: 'clear',
      })
      if (result.ok) this.applyConfig(result.value.config, ['webSearch'])
      else this.error = result.error.message
    },
    async saveLimits() {
      const bridge = window.agentApi
      if (!bridge || !this.limitsConfig || this.limitsSaving) return false

      this.limitsSaving = true
      this.limitsSaveStatus = ''
      try {
        while (this.limitsConfig) {
          const draft = cloneJson(this.limitsConfig)
          const draftSignature = limitsSignature(draft)
          const result = await bridge.setConfig({
            version: IPC_VERSION,
            kind: 'limits',
            value: draft,
          })

          if (!result.ok) {
            this.error = result.error.message
            this.limitsSaveStatus = result.error.message
            return false
          }

          this.limitsSavedSignature = draftSignature
          if (limitsSignature(this.limitsConfig) !== draftSignature) continue

          this.applyConfig(result.value.config, ['limits'])
          this.limitsSaveStatus = 'Saved'
          return true
        }
        return false
      } finally {
        this.limitsSaving = false
      }
    },
    async saveSubagents() {
      const bridge = window.agentApi
      if (!bridge || !this.subagentsConfig || this.subagentsSaving) return false

      this.subagentsSaving = true
      this.subagentsSaveStatus = ''
      try {
        while (this.subagentsConfig) {
          const draft = cloneJson(this.subagentsConfig)
          const draftSignature = subagentsSignature(draft)
          const result = await bridge.setConfig({
            version: IPC_VERSION,
            kind: 'subagents',
            value: draft,
          })

          if (!result.ok) {
            this.error = result.error.message
            this.subagentsSaveStatus = result.error.message
            return false
          }

          this.subagentsSavedSignature = draftSignature
          if (subagentsSignature(this.subagentsConfig) !== draftSignature) {
            continue
          }

          this.applyConfig(result.value.config, ['subagents'])
          this.subagentsSaveStatus = 'Saved'
          return true
        }
        return false
      } finally {
        this.subagentsSaving = false
      }
    },
    async savePermissions(mode: PermissionMode) {
      const bridge = window.agentApi
      if (!bridge) return
      const lines = (value: string) =>
        value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'permission',
        defaultMode: mode,
        builtinPolicies: this.builtinPolicies,
        rememberedRules: this.rememberedRules.map((rule) => ({
          ...rule,
          argConstraints: JSON.parse(rule.argConstraints),
        })),
        sensitiveData: {
          mode: this.permissionForm.sensitiveMode,
          pathGlobs: lines(this.permissionForm.pathGlobs),
          contentPatterns: lines(this.permissionForm.contentPatterns),
        },
      })
      if (result.ok) this.applyConfig(result.value.config, ['permission'])
      else this.error = result.error.message
    },
    async removeRememberedRule(ruleId: string, mode: PermissionMode) {
      this.rememberedRules = this.rememberedRules.filter(
        (rule) => rule.id !== ruleId,
      )
      await this.savePermissions(mode)
    },
    async saveLogging() {
      const bridge = window.agentApi
      if (!bridge) return

      if (this.loggingForm.enabled && !this.traceNoticeAccepted) {
        const notice = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'privacy',
          traceNoticeAccepted: nowNotice(TRACE_NOTICE_VERSION),
        })
        if (!notice.ok) {
          this.error = notice.error.message
          return
        }
        this.applyConfig(notice.value.config, ['privacy'])
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'logging',
        value: {
          enabled: this.loggingForm.enabled,
          retentionDays: Math.max(1, this.loggingForm.retentionDays),
          maxTotalBytes: Math.max(
            1_024,
            Math.round(this.loggingForm.maxTotalMegabytes * 1_000_000),
          ),
        },
      })
      if (result.ok) {
        this.applyConfig(result.value.config, ['logging'])
        this.loggingWarnings = [...(result.value.warnings ?? [])]
      } else this.error = result.error.message
    },
    async acceptProviderNotice() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'privacy',
        providerNoticeAccepted: nowNotice(PROVIDER_NOTICE_VERSION),
      })
      if (result.ok) this.applyConfig(result.value.config, ['privacy'])
      else this.error = result.error.message
    },
    async acceptYoloNotice() {
      const bridge = window.agentApi
      if (!bridge) return false
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'privacy',
        yoloNoticeAccepted: nowNotice(YOLO_NOTICE_VERSION),
      })
      if (result.ok) {
        this.applyConfig(result.value.config, ['privacy'])
        return true
      }
      this.error = result.error.message
      return false
    },
  },
})
