import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  ConfigSection,
  PublicConfig,
  ReasoningEffort,
} from '../../shared/config'

interface ModelRolesState {
  error: string
  defaultModelProvider: string
  defaultModel: string
  defaultModelReasoning: ReasoningEffort
  auxiliaryModelProvider: string
  auxiliaryModel: string
  auxiliaryModelReasoning: ReasoningEffort
  rolesSaving: boolean
  rolesSaveStatus: string
}

interface ModelRolesSelection {
  defaultModelProvider: string
  defaultModel: string
  defaultModelReasoning: ReasoningEffort
  auxiliaryModelProvider: string
  auxiliaryModel: string
  auxiliaryModelReasoning: ReasoningEffort
}

function rolesFromConfig(config: PublicConfig): ModelRolesSelection {
  return {
    defaultModelProvider: config.models.defaultModelProvider,
    defaultModel: config.models.defaultModel,
    defaultModelReasoning: config.models.defaultModelReasoning,
    auxiliaryModelProvider: config.models.auxiliaryModelProvider,
    auxiliaryModel: config.models.auxiliaryModel,
    auxiliaryModelReasoning: config.models.auxiliaryModelReasoning,
  }
}

/** Tracks the persisted default and auxiliary model roles with auto-save writes. */
export const useModelRolesStore = defineStore('model-roles', {
  state: (): ModelRolesState => ({
    error: '',
    defaultModelProvider: '',
    defaultModel: '',
    defaultModelReasoning: 'high',
    auxiliaryModelProvider: '',
    auxiliaryModel: '',
    auxiliaryModelReasoning: 'high',
    rolesSaving: false,
    rolesSaveStatus: '',
  }),
  actions: {
    /** Hydrates the persisted model role selections. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('models')) return
      Object.assign(this, rolesFromConfig(config))
    },
    /** Persists the default model role used by new conversations. */
    async setDefaultModelRole(
      providerId: string,
      model: string,
      reasoning: ReasoningEffort,
    ): Promise<boolean> {
      return this.persistRoles({
        defaultModelProvider: providerId,
        defaultModel: model,
        defaultModelReasoning: reasoning,
        auxiliaryModelProvider: this.auxiliaryModelProvider,
        auxiliaryModel: this.auxiliaryModel,
        auxiliaryModelReasoning: this.auxiliaryModel
          ? this.auxiliaryModelReasoning
          : reasoning,
      })
    },
    /** Persists the auxiliary model role; an empty model follows the default. */
    async setAuxiliaryModelRole(
      providerId: string,
      model: string,
      reasoning: ReasoningEffort,
    ): Promise<boolean> {
      return this.persistRoles({
        defaultModelProvider: this.defaultModelProvider,
        defaultModel: this.defaultModel,
        defaultModelReasoning: this.defaultModelReasoning,
        auxiliaryModelProvider: model ? providerId : '',
        auxiliaryModel: model,
        auxiliaryModelReasoning: model ? reasoning : this.defaultModelReasoning,
      })
    },
    /** Writes both exact model routes with optimistic update and rollback. */
    async persistRoles(next: ModelRolesSelection): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge || this.rolesSaving) return false
      const previous: ModelRolesSelection = {
        defaultModelProvider: this.defaultModelProvider,
        defaultModel: this.defaultModel,
        defaultModelReasoning: this.defaultModelReasoning,
        auxiliaryModelProvider: this.auxiliaryModelProvider,
        auxiliaryModel: this.auxiliaryModel,
        auxiliaryModelReasoning: this.auxiliaryModelReasoning,
      }
      Object.assign(this, next)
      this.rolesSaving = true
      this.rolesSaveStatus = ''
      this.error = ''
      try {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'models',
          value: structuredClone(next),
        })
        if (!result.ok) {
          Object.assign(this, previous)
          this.error = result.error.message
          return false
        }
        this.applyConfig(result.value.config, ['models'])
        this.rolesSaveStatus = 'saved'
        return true
      } finally {
        this.rolesSaving = false
      }
    },
  },
})
