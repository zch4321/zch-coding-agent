// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import ModelRolesSettingsSection from './ModelRolesSettingsSection.vue'
import { NSelect } from 'naive-ui'
import { useAgentStore } from '../../stores/agent'
import { useProviderSettingsStore } from '../../stores/agent-settings'
import {
  toPublicConfig,
  DEFAULT_APP_CONFIG,
} from '../../../electron/config/schema'

describe('ModelRolesSettingsSection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    i18n.global.locale.value = 'zh-CN'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps each model and reasoning select outside implicit labels', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ModelRolesSettingsSection, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })

    const expectedLabels = new Map([
      ['default-model-role-select', '主模型'],
      ['default-model-reasoning-select', '主模型 · 思考深度'],
      ['auxiliary-model-role-select', '辅助模型'],
      ['auxiliary-model-reasoning-select', '辅助模型 · 思考深度'],
    ])

    for (const [testId, accessibleLabel] of expectedLabels) {
      const select = wrapper.get(`[data-testid="${testId}"]`)
      expect(select.element.closest('label')).toBeNull()
      expect(select.attributes('aria-label')).toBe(accessibleLabel)
    }

    wrapper.unmount()
  })

  it('filters known OpenAI reasoning options while preserving an existing invalid selection', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const provider = toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), true)
      .models.providers[0]!
    provider.providerType = 'generic.responses'
    provider.model = 'gpt-6.1-sol'
    provider.enabledModelIds = ['gpt-6.1-sol']
    useProviderSettingsStore().providers = [provider]
    const agent = useAgentStore()
    agent.defaultModelProvider = provider.id
    agent.defaultModel = provider.model
    agent.defaultModelReasoning = 'off'
    const wrapper = mount(ModelRolesSettingsSection, {
      global: { plugins: [pinia, i18n] },
    })
    const select = wrapper
      .findAllComponents(NSelect)
      .find(
        (component) =>
          component.attributes('data-testid') ===
          'default-model-reasoning-select',
      )
    expect(select?.props('options')?.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(select?.props('value')).toBe('off')
    expect(agent.defaultModelReasoning).toBe('off')
    wrapper.unmount()
  })
})
