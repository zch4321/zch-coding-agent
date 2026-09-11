import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { saveSettingsDraft } from './settings-draft-save'

function networkSignature(network: PublicConfig['network']): string {
  return JSON.stringify(network)
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
      if (!bridge) return false
      return saveSettingsDraft({
        owner: this,
        key: 'network',
        read: () => this.networkConfig,
        write: async (draft) => {
          if (draft.httpProxy.mode === 'manual') {
            draft.httpProxy.url = draft.httpProxy.url.trim()
            if (!draft.httpProxy.url)
              throw new Error('Manual proxy URL is required.')
          }
          return bridge.setConfig({
            version: IPC_VERSION,
            kind: 'network',
            value: draft,
          })
        },
        accept: ({ config }, _snapshot, unchanged) => {
          this.networkSavedSignature = networkSignature(config.network)
          if (unchanged) this.networkConfig = structuredClone(config.network)
          this.networkSaveStatus = 'saved'
        },
        pending: (saving) => {
          this.networkSaving = saving
          if (saving) {
            this.networkSaveStatus = ''
            this.error = ''
          }
        },
        fail: (message) => {
          this.error = message
          this.networkSaveStatus = message
        },
      })
    },
  },
})
