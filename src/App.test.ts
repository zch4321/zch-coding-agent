// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('App', () => {
  it('renders the P0 baseline without requiring bridge capabilities', () => {
    const wrapper = mount(App)

    expect(wrapper.get('[data-testid="app-ready"]')).toBeDefined()
    expect(wrapper.text()).toContain('安全基线已就绪')
    expect(wrapper.text()).toContain('Renderer 与 Node.js 隔离')
  })
})
