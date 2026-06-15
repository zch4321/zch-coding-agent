// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('App', () => {
  it('renders the P1 baseline without requiring bridge capabilities', () => {
    const wrapper = mount(App)

    expect(wrapper.get('[data-testid="app-ready"]')).toBeDefined()
    expect(wrapper.text()).toContain('可观测地基已就绪')
    expect(wrapper.text()).toContain('版本化 TypeBox 契约')
  })
})
