// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { NSelect, NTree } from 'naive-ui'
import type { AgentApi } from '../shared/agent-api'
import type { CallId, RunId, SessionId } from '../shared/ids'
import App from './App.vue'
import ArtifactPanel from './components/artifacts/ArtifactPanel.vue'
import ConversationTimeline from './components/chat/ConversationTimeline.vue'
import MessageComposer from './components/chat/MessageComposer.vue'
import ProjectSidebar from './components/projects/ProjectSidebar.vue'
import ProviderSettingsPanel from './components/settings/ProviderSettingsPanel.vue'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../electron/config/schema'
import { i18n, setAppLocale } from './i18n'
import { useAgentStore } from './stores/agent'

function multiProviderConfig() {
  const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
  config.providers[0].modelCatalog = [
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-pro' },
  ]
  config.providers.push({
    ...structuredClone(config.providers[0]),
    id: 'generic',
    label: 'Generic Provider',
    profile: 'generic',
    baseURL: 'https://generic.example/v1',
    model: 'generic-chat',
    reasoning: 'off',
    modelCatalog: [{ id: 'generic-chat' }, { id: 'generic-coder' }],
    modelOverrides: {
      'generic-large': { contextWindowTokens: 128_000 },
    },
    credentialConfigured: false,
    credentialSource: 'none',
  })
  return config
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
}

function clickBodyButton(label: string) {
  const button = [...document.body.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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
    expect(wrapper.text()).toContain('计划')
    expect(wrapper.text()).toContain('变更')
    expect(wrapper.text()).not.toContain('Design frontend layout')
    expect(wrapper.text()).not.toContain('Browser Preview')
    expect(wrapper.text()).not.toContain('Share')
    expect(wrapper.find('[aria-label^="切换终端"]').exists()).toBe(true)
    expect(
      wrapper.find('.conversation-pane .message-input-area').exists(),
    ).toBe(true)
  })

  it('keeps context usage pinned to the latest main model usage', async () => {
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
      },
    })
    const store = useAgentStore(pinia)

    store.usage = [
      {
        runId: 'run:main-usage' as RunId,
        callId: 'llm:main-usage' as CallId,
        order: 1,
        usage: {
          scope: 'main',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'deepseek-v4-pro',
          promptTokens: 20_000,
          completionTokens: 1_000,
          totalTokens: 21_000,
          cacheHitTokens: 12_000,
          cacheMissTokens: 8_000,
          contextWindowTokens: 64_000,
          contextWindowSource: 'default',
          raw: {},
        },
      },
      {
        runId: 'run:main-usage' as RunId,
        callId: 'call:approval-usage' as CallId,
        order: 2,
        usage: {
          scope: 'approval',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'approval-model',
          promptTokens: 2_000,
          completionTokens: 100,
          totalTokens: 2_100,
          cacheHitTokens: 0,
          cacheMissTokens: 2_000,
          contextWindowTokens: 1_000_000,
          contextWindowSource: 'builtin',
          raw: {},
        },
      },
    ]
    await nextTick()

    const summary = wrapper.get('.usage-summary')
    expect(summary.text()).toContain('20,000/64,000')
    expect(summary.text()).toContain('31%')
    expect(summary.text()).toContain('累计 23,100 Token')
    expect(summary.text()).toContain('缓存命中输入 12,000')
    expect(summary.text()).toContain('未命中输入 10,000')
    expect(summary.text()).not.toContain('2,000/1,000,000')
    expect(wrapper.get('.usage-progress span').attributes('style')).toContain(
      'width: 31%',
    )
  })

  it('opens settings as a page from the project sidebar and returns to chat', async () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), i18n],
      },
    })

    await wrapper.get('.sidebar-settings-button').trigger('click')
    await nextTick()

    expect(wrapper.find('.settings-page').exists()).toBe(true)
    expect(wrapper.find('.settings-modal').exists()).toBe(false)
    expect(wrapper.find('.artifact-sidebar').exists()).toBe(false)
    expect(wrapper.text()).toContain('返回主界面')

    await wrapper.get('.settings-back-button').trigger('click')
    await nextTick()

    expect(wrapper.find('.conversation-pane').exists()).toBe(true)
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
      '[aria-label="切换右侧栏（Ctrl+Shift+B）"]',
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
      '[aria-label="切换右侧栏（Ctrl+Shift+B）"]',
    )

    expect(projectToggle.attributes('disabled')).toBeDefined()
    expect(artifactToggle.attributes('disabled')).toBeDefined()
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
        model: 'deepseek-v4-pro',
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
    expect(artifactTabs).toHaveLength(3)
    await artifactTabs[2]?.trigger('click')
    expect(wrapper.find('.diff-view').exists()).toBe(true)
    expect(wrapper.text()).toContain('未选择变更')
  })

  it('renders plans in the right sidebar and opens it when a plan is created', async () => {
    setWindowWidth(1200)
    const pinia = createPinia()
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
      },
    })
    const store = useAgentStore(pinia)
    const artifactToggle = wrapper.get(
      '[aria-label="切换右侧栏（Ctrl+Shift+B）"]',
    )

    expect(artifactToggle.attributes('aria-pressed')).toBe('false')
    store.plan = {
      id: 'plan:test',
      objective: 'Tighten the tool call UI',
      items: [
        {
          id: 'plan:item:one',
          title: 'Move plan into the right sidebar',
          status: 'completed',
          updatedAt: '2026-06-25T00:00:00.000Z',
          result: 'Plan panel added.',
          evidence: 'Artifact tab rendered.',
        },
        {
          id: 'plan:item:two',
          title: 'Open the tab automatically',
          status: 'in_progress',
          updatedAt: '2026-06-25T00:01:00.000Z',
        },
      ],
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:01:00.000Z',
      continuationCount: 1,
      warning: 'Waiting for verification.',
    }
    await nextTick()
    await nextTick()

    expect(artifactToggle.attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.plan-view').exists()).toBe(true)
    expect(wrapper.text()).toContain('Tighten the tool call UI')
    expect(wrapper.text()).toContain('Move plan into the right sidebar')
    expect(wrapper.text()).toContain('Waiting for verification.')
    expect(wrapper.find('.conversation-scroll .plan-item-list').exists()).toBe(
      false,
    )
  })

  it('approves an awaiting plan from the plan tab', async () => {
    const updatePlanStatus = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        accepted: true,
        plan: {
          id: 'plan:test',
          objective: 'Review the plan',
          status: 'active' as const,
          items: [
            {
              id: 'item:1',
              title: 'Inspect state',
              status: 'pending' as const,
              updatedAt: '2026-06-25T00:00:00.000Z',
            },
          ],
          createdAt: '2026-06-25T00:00:00.000Z',
          updatedAt: '2026-06-25T00:01:00.000Z',
          continuationCount: 0,
        },
      },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId: 'run:test' as RunId },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        updatePlanStatus,
        startRun,
      } as Partial<AgentApi> as AgentApi,
    })
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.sessionId = 'session:test' as SessionId
    store.plan = {
      id: 'plan:test',
      objective: 'Review the plan',
      status: 'awaiting_review',
      items: [
        {
          id: 'item:1',
          title: 'Inspect state',
          status: 'pending',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      ],
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:00:00.000Z',
      continuationCount: 0,
    }
    const wrapper = mount(ArtifactPanel, {
      global: { plugins: [pinia, i18n] },
      props: { activeTab: 'plan' },
    })
    const approveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('批准并开始'))

    expect(wrapper.text()).toContain('待审查')
    expect(approveButton).toBeTruthy()
    await approveButton?.trigger('click')
    await flushPromises()

    expect(updatePlanStatus).toHaveBeenCalledWith({
      version: 1,
      sessionId: 'session:test',
      status: 'active',
    })
    expect(startRun).toHaveBeenCalled()
  })

  it('renders provider cards and gates dirty provider switches', async () => {
    const config = multiProviderConfig()
    const setConfig = vi.fn(
      async (payload: Parameters<AgentApi['setConfig']>[0]) => {
        if (payload.kind === 'provider-settings') {
          const provider = config.providers.find(
            (candidate) => candidate.id === payload.providerId,
          )
          if (provider) {
            provider.label = payload.label ?? provider.label
            provider.baseURL = payload.baseURL
            provider.model = payload.model
            provider.reasoning = payload.reasoning
          }
        }
        return {
          version: 1 as const,
          ok: true as const,
          value: { config },
        }
      },
    )
    const listProviderModels = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        models: [
          {
            id: 'generic-chat',
            availability: 'provider' as const,
            capabilitySource: 'default' as const,
            contextWindowTokens: 64_000,
          },
        ],
        stale: false,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        setConfig,
        listProviderModels,
      } as Partial<AgentApi> as AgentApi,
    })
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.applyConfig(config)
    const wrapper = mount(ProviderSettingsPanel, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })

    expect(wrapper.findAll('.provider-card')).toHaveLength(2)
    expect(wrapper.text()).toContain('DeepSeek')
    expect(wrapper.text()).toContain('Generic Provider')
    expect(wrapper.text()).toContain('generic-large')

    store.providerForm.label = 'Unsaved DeepSeek'
    await wrapper.findAll('.provider-card')[1]?.trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('Provider 有未保存修改')

    clickBodyButton('取消')
    await nextTick()
    expect(store.selectedProviderId).toBe('deepseek')

    await wrapper.findAll('.provider-card')[1]?.trigger('click')
    await nextTick()
    clickBodyButton('放弃修改')
    await flushPromises()
    expect(store.selectedProviderId).toBe('generic')

    store.providerForm.baseURL = 'https://changed.example/v1'
    await wrapper.findAll('.provider-card')[0]?.trigger('click')
    await nextTick()
    clickBodyButton('保存并继续')
    await flushPromises()

    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider-settings',
        providerId: 'generic',
        baseURL: 'https://changed.example/v1',
      }),
    )
    expect(store.selectedProviderId).toBe('deepseek')
    wrapper.unmount()
  })

  it('lets the composer switch the active provider', async () => {
    const config = multiProviderConfig()
    const nextConfig = structuredClone(config)
    nextConfig.activeProviderId = 'generic'
    const setConfig = vi.fn(async () => ({
      ok: true as const,
      version: 1 as const,
      value: { config: nextConfig },
    }))
    const listProviderModels = vi.fn(async () => ({
      ok: true as const,
      version: 1 as const,
      value: {
        models: [
          {
            id: 'generic-chat',
            availability: 'provider' as const,
            capabilitySource: 'default' as const,
            contextWindowTokens: 64_000,
          },
        ],
        stale: false,
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        setConfig,
        listProviderModels,
      } as Partial<AgentApi> as AgentApi,
    })
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.applyConfig(config)
    const wrapper = mount(MessageComposer, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })

    const providerSelect = wrapper
      .findAllComponents(NSelect)
      .find((component) =>
        component.classes().includes('composer-provider-select'),
      )
    expect(providerSelect).toBeTruthy()
    providerSelect?.vm.$emit('update:value', 'generic')
    await flushPromises()

    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider-select',
        providerId: 'generic',
      }),
    )
    expect(store.activeProviderId).toBe('generic')
    expect(store.selectedProviderId).toBe('generic')
    expect(store.providerForm.model).toBe('generic-chat')
    wrapper.unmount()
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
      tool: 'create_file',
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

    expect(wrapper.get('.tool-call-summary').text()).toContain('read_file')
    expect(wrapper.get('.tool-call-summary').text()).not.toContain(
      'long-line.txt',
    )
    expect(wrapper.get('.tool-call-summary').text()).not.toContain('xxxxx')
    expect(wrapper.find('.tool-args-json').exists()).toBe(false)
    expect(wrapper.find('.tool-result-json').exists()).toBe(false)

    await wrapper.get('.tool-call-row').trigger('click')
    await nextTick()
    await flushPromises()

    expect(wrapper.get('.tool-args-json').text()).toContain('long-line.txt')
    expect(wrapper.get('.tool-result-json').text()).toContain('xxxxx')
  })

  it('renders compact tool rows with approval usage in expanded details', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    const toolRunId = 'run:approval-usage' as RunId
    const toolCallId = 'call:approval-usage' as CallId
    store.tools = [
      {
        callId: toolCallId,
        runId: toolRunId,
        tool: 'create_file',
        args: { path: 'note.txt', content: 'updated' },
        reason: 'Write the requested file',
        status: 'completed',
        result: {
          status: 'ok',
          content: { path: 'note.txt' },
        },
        approval: {
          approver: 'model',
          decision: 'safe',
          reason: 'Single bounded workspace edit',
          valid: true,
        },
        order: 1,
      },
    ]
    store.usage = [
      {
        runId: toolRunId,
        callId: toolCallId,
        order: 2,
        usage: {
          scope: 'approval',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'approval-model',
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          contextWindowTokens: 64_000,
          contextWindowSource: 'default',
          raw: { decision: 'safe', note: 'bounded write' },
        },
      },
    ]
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })

    expect(wrapper.get('.tool-call-summary').text()).toContain('create_file')
    expect(wrapper.get('.tool-call-summary').text()).not.toContain('note.txt')
    expect(wrapper.find('.tool-approval-json').exists()).toBe(false)

    await wrapper.get('.tool-call-row').trigger('click')
    await nextTick()
    await flushPromises()

    expect(wrapper.get('.tool-approval-meta').text()).toContain('safe')
    expect(wrapper.get('.tool-approval-note').text()).toContain(
      'Single bounded workspace edit',
    )
    expect(wrapper.get('.tool-approval-usage').text()).toContain(
      'approval-model',
    )
    expect(wrapper.get('.tool-approval-json').text()).toContain('bounded write')
  })

  it('does not render empty assistant placeholders before tool calls', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.messages = [
      {
        id: 'message:empty-assistant',
        role: 'assistant',
        runId: 'run:test' as RunId,
        text: '',
        reasoning: '',
        order: 1,
      },
    ]
    store.tools = [
      {
        callId: 'call:read' as CallId,
        runId: 'run:test' as RunId,
        tool: 'read_file',
        args: { path: 'README.md' },
        reason: 'Read the file',
        status: 'proposed',
        order: 2,
      },
    ]
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })

    expect(wrapper.find('.chat-message.assistant').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('...')
    expect(wrapper.get('.tool-call-row').text()).toContain('read_file')
  })

  it('shows the superseded badge for an interjection not applied to the run', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.messages = [
      {
        id: 'message:interjection-superseded',
        role: 'interjection',
        runId: 'run:test' as RunId,
        text: 'Remember to mention the interjection',
        reasoning: '',
        interjectionId: 'interjection:1',
        interjectionStatus: 'superseded',
        order: 1,
      },
    ]
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })
    await flushPromises()

    const interjection = wrapper.get('.chat-message.interjection')
    expect(interjection.text()).toContain(
      'Remember to mention the interjection',
    )
    expect(interjection.find('.interjection-status.superseded').exists()).toBe(
      true,
    )
  })

  it('shows the carryover badge for an interjection pending a new user turn', async () => {
    const pinia = createPinia()
    const store = useAgentStore(pinia)
    store.messages = [
      {
        id: 'message:interjection-carryover',
        role: 'interjection',
        runId: 'run:test' as RunId,
        text: 'Use the alternate approach',
        reasoning: '',
        interjectionId: 'interjection:carryover',
        interjectionStatus: 'carryover',
        order: 1,
      },
    ]
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'example' },
      global: {
        plugins: [pinia, i18n],
      },
    })
    await flushPromises()

    const interjection = wrapper.get('.chat-message.interjection')
    expect(interjection.text()).toContain('Use the alternate approach')
    expect(interjection.find('.interjection-status.carryover').exists()).toBe(
      true,
    )
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
