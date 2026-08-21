import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'

function networkSignature(network: PublicConfig['network']): string {
  return JSON.stringify(network)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const useNetworkSettingsStore = defineStore('network-settings', {
  state: () => ({
    error: '',
    networkConfig: {
      httpProxy: { mode: 'off' },
    } as PublicConfig['network'],
    networkSavedSignature: '',
    networkSaving: false,
    networkSaveStatus: '',
  }),
  getters: {
    networkDirty: (state) =>
      networkSignature(state.networkConfig) !== state.networkSavedSignature,
  },
  actions: {
    /** Hydrates the application network proxy draft from public config. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('network')) return
      this.networkConfig = structuredClone(config.network)
      this.networkSavedSignature = networkSignature(config.network)
    },
    /** Validates and persists the current network proxy draft. */
    async saveNetwork(): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge || this.networkSaving) return false

      const draft = cloneJson(this.networkConfig)
      if (draft.httpProxy.mode === 'manual') {
        draft.httpProxy.url = draft.httpProxy.url.trim()
        if (!draft.httpProxy.url) {
          this.error = 'Manual proxy URL is required.'
          return false
        }
      }

      this.networkSaving = true
      this.networkSaveStatus = ''
      try {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'network',
          value: draft,
        })
        if (!result.ok) {
          this.error = result.error.message
          this.networkSaveStatus = result.error.message
          return false
        }
        this.applyConfig(result.value.config, ['network'])
        this.networkSaveStatus = 'saved'
        return true
      } finally {
        this.networkSaving = false
      }
    },
  },
})
