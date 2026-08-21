import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'

export const useIntegrationSettingsStore = defineStore('integration-settings', {
  state: () => ({
    error: '',
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
    webSearchDirty: (state) =>
      Boolean(
        state.webSearchForm.apiKey.trim() ||
        `${state.webSearchForm.provider}|${state.webSearchForm.count}` !==
          state.webSearchSavedSignature,
      ),
  },
  actions: {
    /** Hydrates Web Search settings owned by the integrations domain. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('webSearch')) return
      this.webSearchForm.provider = config.webSearch.provider
      this.webSearchForm.count = config.webSearch.count
      this.webSearchForm.apiKey = ''
      this.webSearchCredentialConfigured = config.webSearch.credentialConfigured
      this.webSearchSavedSignature = `${config.webSearch.provider}|${config.webSearch.count}`
    },
    /** Persists Web Search configuration and any newly entered credential. */
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
    /** Clears the stored Web Search credential. */
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
  },
})
