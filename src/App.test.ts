// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { NTree } from 'naive-ui'
import type { AgentApi } from '../shared/agent-api'
import type { CallId, RunId, SessionId } from '../shared/ids'
import App from './App.vue'
import ArtifactPanel from './components/artifacts/ArtifactPanel.vue'
import ConversationTimeline from './components/chat/ConversationTimeline.vue'
import ProjectSidebar from './components/projects/ProjectSidebar.vue'
import { i18n, setAppLocale } from './i18n'
import { useAgentStore } from './stores/agent'

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
}

describe('App', () => {
  beforeEach(() => {
    setAppLocale('zh-CN')
    setWindowWidth(1024)
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    })
  })
  afterEach(() => {
    setWindowWidth(1024)
    Reflect.deleteProperty(window, 'agentApi')
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('renders the P4 workbench without post-MVP placeholders', () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), i18n],
      },
    })

    expect(wrapper.get('[data-testid="app-ready"]')).toBeDefined()
    expect(wrapper.text()).toContain('Zch Coding Agent')
    expect(wrapper.text()).toContain('新建对话')
    expect(wrapper.text()).toContain('文件')
    expect(wrapper.text()).toContain('变更')
    expect(wrapper.text()).not.toContain('Design frontend layout')
    expect(wrapper.text()).not.toContain('Browser Preview')
    expect(wrapper.text()).not.toContain('Share')
    expect(wrapper.find('[aria-label^="切换终端"]').exists()).toBe(true)
    expect(
      wrapper.find('.conversation-pane .message-input-area').exists(),
    ).toBe(true)
  })

  it('keeps at most one docked sidebar open when both do not fit', async () => {
    setWindowWidth(1000)
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), i18n],
      },
    })
    const projectToggle = wrapper.get('[aria-label="切换项目侧栏（Ctrl+B）"]')
    const artifactToggle = wrapper.get(
      '[aria-label="切换文件侧栏（Ctrl+Shift+B）"]',
    )

    expect(projectToggle.attributes('aria-pressed')).toBe('true')
    expect(artifactToggle.attributes('aria-pressed')).toBe('false')

    await artifactToggle.trigger('click')

    expect(projectToggle.attributes('aria-pressed')).toBe('false')
    expect(artifactToggle.attributes('aria-pressed')).toBe('true')

    await projectToggle.trigger('click')

    expect(projectToggle.attributes('aria-pressed')).toBe('true')
    expect(artifactToggle.attributes('aria-pressed')).toBe('false')
  })

  it('disables docked sidebars that cannot preserve the conversation width', async () => {
    setWindowWidth(600)
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), i18n],
      },
    })
    await nextTick()
    const projectToggle = wrapper.get('[aria-label="切换项目侧栏（Ctrl+B）"]')
    const artifactToggle = wrapper.get(
      '[aria-label="切换文件侧栏（Ctrl+Shift+B）"]',
    )

    expect(projectToggle.attributes('disabled')).toBeDefined()
    expect(artifactToggle.attributes('disabled')).toBeDefined()
    expect(projectToggle.element.parentElement?.title).toBe(
      '窗口宽度不足，放大窗口后可打开侧栏',
    )
    expect(artifactToggle.element.parentElement?.title).toBe(
      '窗口宽度不足，放大窗口后可打开侧栏',
    )
  })

  it('searches persisted conversation text locally and switches artifact tabs', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
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
    expect(wrapper.text()).toContain('未选择变更')
  })

  it('renders approval injection content as inert text', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
      },
    })
    const store = useAgentStore(pinia)
    const injection = '<script>window.pwned=true</script><img src=x onerror=1>'
    store.sessionId = 'session:test' as SessionId

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

  it('keeps request failures visible outside the scrollable history', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
      },
    })
    const store = useAgentStore(pinia)
    store.error = 'Approval request failed'
    await nextTick()

    expect(wrapper.get('.conversation-error-overlay').text()).toContain(
      'Approval request failed',
    )
    expect(
      wrapper.find('.conversation-scroll .conversation-error-overlay').exists(),
    ).toBe(false)
  })

  it('resets the back-to-bottom state when the conversation changes', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.activeConversationId = 'conversation:one'
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })

    const scroll = wrapper.get('.conversation-scroll')
    Object.defineProperties(scroll.element, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    await scroll.trigger('scroll')
    expect(wrapper.find('.back-to-bottom').exists()).toBe(true)

    store.activeConversationId = 'conversation:two'
    await nextTick()
    await nextTick()

    expect(wrapper.find('.back-to-bottom').exists()).toBe(false)
  })

  it('renders tool arguments and results only after expansion', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.tools = [
      {
        callId: 'call:long' as CallId,
        runId: 'run:test' as RunId,
        tool: 'read_file',
        args: { path: 'long-line.txt' },
        reason: 'Inspect a file with long output',
        status: 'completed',
        result: {
          status: 'ok',
          content: { text: 'x'.repeat(5_000) },
        },
        order: 1,
      },
    ]
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })

    expect(wrapper.find('.tool-args-json').exists()).toBe(false)
    expect(wrapper.find('.tool-result-json').exists()).toBe(false)

    await wrapper.get('.n-collapse-item__header-main').trigger('click')
    await nextTick()
    await flushPromises()

    expect(wrapper.get('.tool-args-json').text()).toContain('long-line.txt')
    expect(wrapper.get('.tool-result-json').text()).toContain('xxxxx')
  })

  it('collapses and expands a project conversation group', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.projects = [
      {
        path: 'F:/workspace/example',
        name: 'example',
        addedAt: '2026-06-21T00:00:00.000Z',
      },
    ]
    store.conversations = [
      {
        id: 'conversation:one',
        projectPath: 'F:/workspace/example',
        title: 'Review UI',
        model: 'deepseek-v4-pro',
        mode: 'auto',
        messages: [],
        tools: [],
        createdAt: '2026-06-21T00:00:00.000Z',
        updatedAt: '2026-06-21T00:00:00.000Z',
      },
    ]
    const wrapper = mount(ProjectSidebar, {
      global: { plugins: [pinia, i18n] },
    })
    const heading = wrapper.get('.project-heading')

    expect(heading.attributes('aria-expanded')).toBe('true')
    await heading.trigger('click')
    expect(heading.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.conversation-list').attributes('style')).toContain(
      'display: none',
    )

    await heading.trigger('click')
    expect(heading.attributes('aria-expanded')).toBe('true')
  })

  it('creates a conversation from an empty project heading', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.projects = [
      {
        path: 'F:/workspace/empty',
        name: 'empty',
        addedAt: '2026-06-21T00:00:00.000Z',
      },
    ]
    const wrapper = mount(ProjectSidebar, {
      global: { plugins: [pinia, i18n] },
    })

    await wrapper.get('.project-new-conversation-button').trigger('click')

    expect(wrapper.emitted('create')?.[0]).toEqual(['F:/workspace/empty'])
  })

  it('ignores a stale directory response after switching projects', async () => {
    type DirectoryResult = Awaited<
      ReturnType<AgentApi['listWorkspaceDirectory']>
    >
    let resolveFirst!: (result: DirectoryResult) => void
    let resolveSecond!: (result: DirectoryResult) => void
    let call = 0
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listWorkspaceDirectory: () => {
          call += 1
          return new Promise<DirectoryResult>((resolve) => {
            if (call === 1) resolveFirst = resolve
            else resolveSecond = resolve
          })
        },
      } as Partial<AgentApi> as AgentApi,
    })
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.workspacePath = 'F:/workspace/first'
    const wrapper = mount(ArtifactPanel, {
      global: { plugins: [pinia, i18n] },
    })
    await nextTick()

    store.workspacePath = 'F:/workspace/second'
    await nextTick()
    resolveSecond({
      version: 1,
      ok: true,
      value: {
        workspace: 'F:/workspace/second',
        path: '.',
        entries: [{ path: 'second.txt', name: 'second.txt', type: 'file' }],
        truncated: false,
      },
    })
    await flushPromises()
    expect(wrapper.getComponent(NTree).props('data')).toMatchObject([
      { path: 'second.txt', label: 'second.txt', entryType: 'file' },
    ])

    resolveFirst({
      version: 1,
      ok: true,
      value: {
        workspace: 'F:/workspace/first',
        path: '.',
        entries: [{ path: 'first.txt', name: 'first.txt', type: 'file' }],
        truncated: false,
      },
    })
    await flushPromises()

    expect(wrapper.getComponent(NTree).props('data')).toMatchObject([
      { path: 'second.txt', label: 'second.txt', entryType: 'file' },
    ])
  })
})
