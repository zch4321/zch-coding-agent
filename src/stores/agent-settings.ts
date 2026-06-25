import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AssistantLanguage,
  ConfigSection,
  PermissionMode,
  ProviderPublicConfig,
  PublicConfig,
} from '../../shared/config'
import { getProviderConfig } from '../../shared/config'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
  YOLO_NOTICE_VERSION,
} from '../../shared/notices'
import { DEFAULT_ASSISTANT_PREFERENCES } from '../../shared/system-prompts'
import { nowNotice, toUiRememberedRules } from './config-mapping'
import type { UiModelProfile, UiRememberedRule } from './agent-types'
import { DEFAULT_PROVIDER_FORM, providerFormSignature } from './provider-form'

function providerModelProfiles(
  provider: ProviderPublicConfig | undefined,
  fallbackContextWindowTokens: number,
): UiModelProfile[] {
  if (!provider) return []

  const ids = new Set<string>([
    provider.model,
    ...provider.modelCatalog.map((model) => model.id),
    ...Object.keys(provider.modelOverrides),
  ])

  return [...ids].map((id) => {
    const catalogModel = provider.modelCatalog.find((model) => model.id === id)
    const override = provider.modelOverrides[id]
    return {
      id,
      ownedBy: catalogModel?.ownedBy,
      availability: catalogModel ? 'provider' : 'custom',
      capabilitySource: override ? 'override' : 'default',
      contextWindowTokens:
        override?.contextWindowTokens ?? fallbackContextWindowTokens,
      ...(override?.maxOutputTokens
        ? { maxOutputTokens: override.maxOutputTokens }
        : {}),
    }
  })
}

function providerPreviewModels(provider: ProviderPublicConfig): string[] {
  const ids = new Set<string>([
    provider.model,
    ...provider.modelCatalog.map((model) => model.id),
    ...Object.keys(provider.modelOverrides),
  ])
  return [...ids].slice(0, 3)
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
    modelOverrides: {} as ProviderPublicConfig['modelOverrides'],
    limitsConfig: undefined as PublicConfig['limits'] | undefined,
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
    activeProviderModel: (state) =>
      state.providers.find((provider) => provider.id === state.activeProviderId)
        ?.model ?? state.providerForm.model,
    modelOptions: (state) =>
      state.modelProfiles.map((model) => ({
        label: model.id,
        value: model.id,
      })),
    providerOptions: (state) =>
      state.providers.map((provider) => ({
        label: provider.label,
        value: provider.id,
      })),
    providerCardSummaries: (state) =>
      state.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        profile: provider.profile,
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
        providerFormSignature(state.providerForm) !==
          state.providerSavedSignature,
      ),
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
      this.providerForm.profile = provider.profile
      this.providerForm.baseURL = provider.baseURL
      this.providerForm.model = provider.model
      this.providerForm.reasoning = provider.reasoning
      this.providerForm.apiKey = ''
      this.modelOverrides = cloneJson(provider.modelOverrides)
      this.modelProfiles = providerModelProfiles(
        provider,
        (config?.limits ?? this.limitsConfig)?.maxContextTokens ?? 64_000,
      )
      this.modelCatalogFetchedAt = provider.modelCatalogFetchedAt
      this.modelCatalogStale =
        !provider.modelCatalogFetchedAt ||
        Date.now() - new Date(provider.modelCatalogFetchedAt).getTime() >
          24 * 60 * 60_000

      const approval = config?.approval
      if (approval) {
        this.providerForm.approverProviderId = approval.approverProviderId
        this.providerForm.approverModel = approval.approverModel
      }

      const limits = config?.limits ?? this.limitsConfig
      if (limits) {
        this.providerForm.tokenEstimationMode = limits.tokenEstimation.mode
        this.providerForm.bytesPerToken = limits.tokenEstimation.bytesPerToken
      }

      this.syncModelOverride(provider.model)
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

      if (includes('approval')) {
        this.providerForm.approverProviderId =
          config.approval.approverProviderId
        this.providerForm.approverModel = config.approval.approverModel
      }

      if (includes('limits')) {
        this.limitsConfig = structuredClone(config.limits)
        this.providerForm.tokenEstimationMode =
          config.limits.tokenEstimation.mode
        this.providerForm.bytesPerToken =
          config.limits.tokenEstimation.bytesPerToken
      }

      if (includes('providers') || includes('approval') || includes('limits')) {
        this.hydrateSelectedProviderForm(config)
        this.providerSavedSignature = providerFormSignature(this.providerForm)
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
    syncModelOverride(model: string) {
      const override = this.modelOverrides[model]
      this.providerForm.contextWindowTokens =
        override?.contextWindowTokens ?? null
      this.providerForm.maxOutputTokens = override?.maxOutputTokens ?? null
    },
    async selectProviderForEditing(providerId: string, refreshModels = true) {
      if (!this.providers.some((provider) => provider.id === providerId)) {
        return false
      }

      this.selectedProviderId = providerId
      this.hydrateSelectedProviderForm()
      this.providerSavedSignature = providerFormSignature(this.providerForm)
      if (refreshModels) await this.loadProviderModels(false)
      return true
    },
    resetSelectedProviderDraft() {
      this.hydrateSelectedProviderForm()
      this.providerSavedSignature = providerFormSignature(this.providerForm)
    },
    setProviderModel(model: string) {
      this.providerForm.model = model
      this.syncModelOverride(model)

      if (!this.modelProfiles.some((candidate) => candidate.id === model)) {
        const fallbackContext = this.limitsConfig?.maxContextTokens ?? 64_000
        this.modelProfiles.push({
          id: model,
          availability: 'custom',
          capabilitySource: 'default',
          contextWindowTokens: fallbackContext,
        })
      }
    },
    async loadProviderModels(refresh: boolean) {
      const bridge = window.agentApi

      if (!bridge || this.modelCatalogLoading) return
      this.modelCatalogLoading = true
      const providerId = this.selectedProviderId

      try {
        const result = await bridge.listProviderModels({
          version: IPC_VERSION,
          refresh,
          providerId,
        })
        if (!result.ok) {
          if (refresh) this.error = result.error.message
          return
        }

        if (refresh) {
          const configResult = await bridge.getConfig({
            version: IPC_VERSION,
            section: 'providers',
          })
          if (configResult.ok) {
            this.applyConfig(configResult.value.config, ['providers'])
          }
        }

        if (providerId !== this.selectedProviderId) return
        this.modelProfiles = result.value.models
        this.modelCatalogFetchedAt = result.value.fetchedAt
        this.modelCatalogStale = result.value.stale
      } finally {
        this.modelCatalogLoading = false
      }
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
        profile: 'generic',
        baseURL: 'https://api.example.com/v1',
        model: 'model-name',
        reasoning: 'off',
        approverProviderId: this.providerForm.approverProviderId,
        approverModel: this.providerForm.approverModel,
        limits: cloneJson(limits),
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.selectedProviderId = providerId
      this.applyConfig(result.value.config, ['providers', 'approval', 'limits'])
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
      this.applyConfig(result.value.config, ['providers', 'approval'])
      return true
    },
    async saveProvider() {
      const bridge = window.agentApi
      if (!bridge || this.providerSaving) return false

      this.error = ''
      this.providerSaveStatus = ''
      const draft = { ...this.providerForm }
      const limits = this.limitsConfig
      if (!limits) {
        this.error = 'Provider settings are not initialized.'
        return false
      }

      this.providerSaving = true
      try {
        const apiKey = draft.apiKey.trim()
        const saved = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'provider-settings',
          baseURL: draft.baseURL,
          model: draft.model,
          contextWindowTokens: draft.contextWindowTokens,
          maxOutputTokens: draft.maxOutputTokens,
          reasoning: draft.reasoning,
          providerId: draft.providerId,
          label: draft.label,
          profile: draft.profile,
          approverProviderId: draft.approverProviderId,
          approverModel: draft.approverModel,
          limits: {
            ...limits,
            tokenEstimation: {
              mode: draft.tokenEstimationMode,
              bytesPerToken: draft.bytesPerToken,
            },
          },
          ...(apiKey ? { apiKey } : {}),
        })
        if (!saved.ok) {
          this.error = saved.error.message
          return false
        }
        this.applyConfig(saved.value.config, [
          'providers',
          'approval',
          'limits',
        ])
        this.providerForm.apiKey = ''
        this.providerSaveStatus = 'Saved'
        return true
      } finally {
        this.providerSaving = false
      }
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
      if (result.ok) this.applyConfig(result.value.config, ['providers'])
      else this.error = result.error.message
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
      if (result.ok) this.applyConfig(result.value.config, ['logging'])
      else this.error = result.error.message
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
