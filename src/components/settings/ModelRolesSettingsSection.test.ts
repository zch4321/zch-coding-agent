// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import ModelRolesSettingsSection from './ModelRolesSettingsSection.vue'

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
})
