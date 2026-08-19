import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { AssistantLanguage } from '../../shared/config/assistant'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { DEFAULT_ASSISTANT_PREFERENCES } from '../../shared/system-prompts'

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
    },
    /** Persists assistant language and localized preferences. */
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
  },
})
