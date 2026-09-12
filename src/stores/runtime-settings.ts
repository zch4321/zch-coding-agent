import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { saveSettingsDraft } from './settings-draft-save'
import { useProviderSettingsStore } from './agent-settings'
import type {
  CommandShellCatalog,
  CommandShellSelection,
} from '../../shared/command-shell'

function limitsSignature(limits: PublicConfig['limits'] | undefined): string {
  return limits ? JSON.stringify(limits) : ''
}

function subagentsSignature(
  subagents: PublicConfig['subagents'] | undefined,
): string {
  return subagents ? JSON.stringify(subagents) : ''
}

export const useRuntimeSettingsStore = defineStore('runtime-settings', {
  state: () => ({
    error: '',
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
  }),
  getters: {
    limitsDirty: (state) =>
      limitsSignature(state.limitsConfig) !== state.limitsSavedSignature,
    subagentsDirty: (state) =>
      subagentsSignature(state.subagentsConfig) !==
      state.subagentsSavedSignature,
  },
  actions: {
    /** Hydrates runtime limits, subagent policy, and execution environment. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      const includes = (section: ConfigSection) =>
        sections.includes('all') || sections.includes(section)
      if (includes('limits')) {
        this.limitsConfig = structuredClone(config.limits)
        this.limitsSavedSignature = limitsSignature(config.limits)
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
    },
    /** Discovers command shells available to the current application process. */
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
    /** Persists the command shell used by future command executions. */
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
    /** Persists the latest runtime limit draft without dropping concurrent edits. */
    async saveLimits() {
      const bridge = window.agentApi
      if (!bridge) return false
      return saveSettingsDraft({
        owner: this,
        key: 'limits',
        read: () => this.limitsConfig,
        drain: true,
        write: (draft) =>
          bridge.setConfig({
            version: IPC_VERSION,
            kind: 'limits',
            value: draft,
          }),
        accept: ({ config }, _snapshot, unchanged) => {
          this.limitsSavedSignature = limitsSignature(config.limits)
          useProviderSettingsStore().applyConfig(config, ['limits'])
          if (unchanged) this.applyConfig(config, ['limits'])
          this.limitsSaveStatus = 'Saved'
        },
        pending: (saving) => {
          this.limitsSaving = saving
          if (saving) {
            this.limitsSaveStatus = ''
            this.error = ''
          }
        },
        fail: (message) => {
          this.error = message
          this.limitsSaveStatus = message
        },
      })
    },
    /** Persists the latest subagent policy draft without dropping concurrent edits. */
    async saveSubagents() {
      const bridge = window.agentApi
      if (!bridge) return false
      return saveSettingsDraft({
        owner: this,
        key: 'subagents',
        read: () => this.subagentsConfig,
        drain: true,
        write: (draft) =>
          bridge.setConfig({
            version: IPC_VERSION,
            kind: 'subagents',
            value: draft,
          }),
        accept: ({ config }, _snapshot, unchanged) => {
          this.subagentsSavedSignature = subagentsSignature(config.subagents)
          if (unchanged) this.applyConfig(config, ['subagents'])
          this.subagentsSaveStatus = 'Saved'
        },
        pending: (saving) => {
          this.subagentsSaving = saving
          if (saving) {
            this.subagentsSaveStatus = ''
            this.error = ''
          }
        },
        fail: (message) => {
          this.error = message
          this.subagentsSaveStatus = message
        },
      })
    },
  },
})
