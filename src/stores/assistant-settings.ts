import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { AssistantLanguage } from '../../shared/config/assistant'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { DEFAULT_ASSISTANT_PREFERENCES } from '../../shared/system-prompts'
import { saveSettingsDraft } from './settings-draft-save'

const savedLanguages = new WeakMap<object, AssistantLanguage>()

export const useAssistantSettingsStore = defineStore('assistant-settings', {
  state: () => ({
    error: '',
    assistantForm: {
      language: 'zh-CN' as AssistantLanguage,
      preferences: structuredClone(DEFAULT_ASSISTANT_PREFERENCES),
    },
    assistantSaving: false,
    assistantSaveStatus: '',
  }),
  actions: {
    /** Hydrates assistant language and preference drafts from public config. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('assistant')) return
      this.assistantForm = structuredClone(config.assistant)
      savedLanguages.set(this, config.assistant.language)
    },
    /** Persists assistant language and localized preferences. */
    async saveAssistantSettings(language?: AssistantLanguage) {
      const bridge = window.agentApi
      const targetLanguage = language ?? this.assistantForm.language

      if (!bridge) {
        this.assistantForm.language = targetLanguage
        return true
      }

      if (!savedLanguages.has(this))
        savedLanguages.set(this, this.assistantForm.language)
      this.assistantForm.language = targetLanguage
      return saveSettingsDraft({
        owner: this,
        key: 'assistant',
        read: () => this.assistantForm,
        write: (draft) =>
          bridge.setConfig({
            version: IPC_VERSION,
            kind: 'assistant',
            value: {
              language: draft.language,
              preferences: {
                'zh-CN': draft.preferences['zh-CN'].trim(),
                'en-US': draft.preferences['en-US'].trim(),
              },
            },
          }),
        accept: ({ config }, _snapshot, unchanged) => {
          savedLanguages.set(this, config.assistant.language)
          if (unchanged) this.applyConfig(config, ['assistant'])
          this.assistantSaveStatus = unchanged ? 'saved' : ''
        },
        pending: (saving) => {
          this.assistantSaving = saving
          if (saving) {
            this.assistantSaveStatus = ''
            this.error = ''
          }
        },
        fail: (message) => {
          this.error = message
          this.assistantSaveStatus = message
          this.assistantForm.language =
            savedLanguages.get(this) ?? this.assistantForm.language
        },
      })
    },
  },
})
