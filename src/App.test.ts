// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import App from './App.vue'

describe('App', () => {
  it('renders the P2 workbench without requiring bridge capabilities', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
      },
    })

    expect(wrapper.get('[data-testid="app-ready"]')).toBeDefined()
    expect(wrapper.text()).toContain('My Coding Agent')
    expect(wrapper.text()).toContain('Design frontend layout')
    expect(wrapper.text()).toContain('Files')
  })
})
