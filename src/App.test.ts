// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import type { CallId, RunId, SessionId } from '../shared/ids'
import App from './App.vue'
import { useAgentStore } from './stores/agent'

describe('App', () => {
  it('renders the P3 workbench without fake or future-stage features', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
      },
    })

    expect(wrapper.get('[data-testid="app-ready"]')).toBeDefined()
    expect(wrapper.text()).toContain('My Coding Agent')
    expect(wrapper.text()).toContain('New conversation')
    expect(wrapper.text()).toContain('Files')
    expect(wrapper.text()).toContain('Diff')
    expect(wrapper.text()).not.toContain('Design frontend layout')
    expect(wrapper.text()).not.toContain('Browser Preview')
    expect(wrapper.text()).not.toContain('Terminal')
    expect(wrapper.text()).not.toContain('Share')
    expect(
      wrapper.find('.conversation-pane .message-input-area').exists(),
    ).toBe(true)
  })

  it('searches persisted conversation text locally and switches artifact tabs', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia],
      },
    })
    const store = useAgentStore(pinia)
    store.projects = [
      {
        path: 'F:/workspace/example',
        name: 'example',
        addedAt: '2026-06-18T00:00:00.000Z',
      },
    ]
    store.conversations = [
      {
        id: 'conversation:one',
        projectPath: 'F:/workspace/example',
        title: 'Review permissions',
        model: 'deepseek-chat',
        mode: 'confirm',
        messages: [
          {
            id: 'message:one',
            role: 'user',
            text: 'Inspect the approval pipeline',
            reasoning: '',
          },
        ],
        createdAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
      },
    ]
    await nextTick()

    await wrapper.get('input[type="search"]').setValue('approval pipeline')
    expect(wrapper.text()).toContain('Review permissions')
    expect(wrapper.text()).toContain('example')

    const artifactTabs = wrapper.findAll('.artifact-tabs button')
    expect(artifactTabs).toHaveLength(2)
    await artifactTabs[1]?.trigger('click')
    expect(wrapper.find('.diff-view').exists()).toBe(true)
    expect(wrapper.text()).toContain('No diff selected')
  })

  it('renders approval injection content as inert text', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia],
      },
    })
    const store = useAgentStore(pinia)
    const injection = '<script>window.pwned=true</script><img src=x onerror=1>'

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-18T00:00:00.000Z',
      type: 'approval.requested',
      sessionId: 'session:test' as SessionId,
      runId: 'run:test' as RunId,
      callId: 'call:test' as CallId,
      kind: 'tool',
      tool: 'write_file',
      args: { path: 'note.txt', content: injection },
      reason: injection,
      policySignals: [
        { code: 'injection', severity: 'danger', detail: injection },
      ],
      diff: injection,
      rememberable: true,
      expiresAt: '2026-06-18T00:10:00.000Z',
    })
    await nextTick()

    expect(wrapper.text()).toContain(injection)
    expect(wrapper.find('.approval-card script').exists()).toBe(false)
    expect(wrapper.find('.approval-card img').exists()).toBe(false)
  })
})
