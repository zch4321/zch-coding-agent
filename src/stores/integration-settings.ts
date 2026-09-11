import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { isSettingsSavePending, saveSettingsDraft } from './settings-draft-save'

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
      if (!bridge || isSettingsSavePending(this, 'web-search-clear'))
        return false
      return saveSettingsDraft({
        owner: this,
        key: 'web-search',
        read: () => this.webSearchForm,
        write: async (draft) => {
          const apiKey = draft.apiKey.trim()
          if (apiKey) {
            const result = await bridge.setConfig({
              version: IPC_VERSION,
              kind: 'web-search-credential',
              action: 'set',
              apiKey,
            })
            if (!result.ok) return result
            this.webSearchCredentialConfigured =
              result.value.config.webSearch.credentialConfigured
          }
          const clearCommittedKey = () => {
            if (apiKey && this.webSearchForm.apiKey === draft.apiKey)
              this.webSearchForm.apiKey = ''
          }
          try {
            const result = await bridge.setConfig({
              version: IPC_VERSION,
              kind: 'web-search',
              provider: draft.provider,
              count: draft.count,
            })
            // A credential write remains committed when the configuration step fails.
            if (!result.ok) clearCommittedKey()
            return result
          } catch (error) {
            clearCommittedKey()
            throw error
          }
        },
        accept: ({ config }, snapshot, unchanged) => {
          this.webSearchSavedSignature = `${config.webSearch.provider}|${config.webSearch.count}`
          this.webSearchCredentialConfigured =
            config.webSearch.credentialConfigured
          if (unchanged) {
            this.webSearchForm.provider = config.webSearch.provider
            this.webSearchForm.count = config.webSearch.count
          }
          if (this.webSearchForm.apiKey === snapshot.value.apiKey)
            this.webSearchForm.apiKey = ''
          this.webSearchSaveStatus = 'saved'
        },
        pending: (saving) => {
          this.webSearchSaving = saving
          if (saving) {
            this.webSearchSaveStatus = ''
            this.error = ''
          }
        },
        fail: (message) => {
          this.error = message
          this.webSearchSaveStatus = message
        },
      })
    },
    /** Clears the stored Web Search credential. */
    async clearWebSearchCredential() {
      const bridge = window.agentApi
      if (!bridge || this.webSearchSaving) return false
      return saveSettingsDraft({
        owner: this,
        key: 'web-search-clear',
        read: () => this.webSearchForm,
        write: () =>
          bridge.setConfig({
            version: IPC_VERSION,
            kind: 'web-search-credential',
            action: 'clear',
          }),
        accept: ({ config }) => {
          this.webSearchCredentialConfigured =
            config.webSearch.credentialConfigured
        },
        pending: (saving) => {
          this.webSearchSaving = saving
        },
        fail: (message) => {
          this.error = message
        },
      })
    },
  },
})
