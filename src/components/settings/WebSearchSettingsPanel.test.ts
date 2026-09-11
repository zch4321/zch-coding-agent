// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import { useIntegrationSettingsStore } from '../../stores/integration-settings'
import WebSearchSettingsPanel from './WebSearchSettingsPanel.vue'

describe('Web Search settings input', () => {
  it('binds native password input to the credential draft and enables saving', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      messages: {},
      missingWarn: false,
      fallbackWarn: false,
    })
    const wrapper = mount(WebSearchSettingsPanel, {
      global: { plugins: [pinia, i18n] },
    })
    try {
      await wrapper.get('input[type="password"]').setValue('synthetic-key')
      const store = useIntegrationSettingsStore()
      expect(store.webSearchForm.apiKey).toBe('synthetic-key')
      expect(store.webSearchDirty).toBe(true)
      const save = wrapper
        .findAll('button')
        .find((button) => button.text() === 'settings.saveWebSearch')!
      expect(save.attributes('disabled')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })
})
