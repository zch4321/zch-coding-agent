// @vitest-environment jsdom

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type {
  AgentExecutionDetail,
  AgentExecutionSummary,
} from '../../../shared/agent-execution'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentExecutionStore } from '../../stores/agent-executions'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import ArtifactPanel from './ArtifactPanel.vue'
import AgentsTab from './AgentsTab.vue'

const timestamp = '2026-08-01T00:00:00.000Z'
const parentSessionId = 'session:agents-component' as SessionId
const execution: AgentExecutionSummary = {
  schemaVersion: 1,
  id: 'subagent:agents-component' as AgentExecutionId,
  kind: 'subagent',
  parentSessionId,
  parentRunId: 'run:agents-component' as RunId,
  parentCallId: 'call:agents-component' as CallId,
  name: 'review-worker',
  status: 'running',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  createdAt: timestamp,
  updatedAt: timestamp,
}

const detail: AgentExecutionDetail = {
  schemaVersion: 1,
  summary: execution,
  task: 'Review the current repository.',
  statistics: { toolCallCount: 1 },
  activityPage: {
    schemaVersion: 1,
    records: [
      {
        id: 'reasoning:component',
        type: 'reasoning',
        seq: 2,
        ordinal: 0,
        text: 'Inspect the implementation carefully.',
      },
      {
        id: 'call:component-read',
        type: 'tool',
        seq: 2,
        ordinal: 1,
        callId: 'call:component-read' as CallId,
        tool: 'read_file',
        args: { path: 'README.md' },
        reason: 'Read the documentation',
        status: 'completed',
        result: { status: 'ok', content: { text: 'fixture' } },
      },
      {
        id: 'message:component',
        type: 'message',
        seq: 4,
        ordinal: 0,
        text: 'The review is in progress.',
      },
    ],
    hasMore: false,
  },
}

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

describe('Agents artifact tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setAppLocale('zh-CN')
    useAgentReplicaStore().selectedSessionId = parentSessionId
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('never auto-expands and shows only statistics plus messages after a manual expansion', async () => {
    const listAgentExecutions = vi.fn(async () =>
      success({
        page: {
          schemaVersion: 1 as const,
          records: [execution],
          hasMore: false as const,
        },
      }),
    )
    const getAgentExecution = vi.fn(async () => success({ detail }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listAgentExecutions,
        getAgentExecution,
      } as Partial<AgentApi> as AgentApi,
    })

    const wrapper = mount(AgentsTab, {
      global: { plugins: [i18n] },
    })
    await vi.waitFor(() =>
      expect(useAgentExecutionStore().sessions[parentSessionId]?.loaded).toBe(
        true,
      ),
    )
    await flushPromises()
    await wrapper.vm.$nextTick()
    expect(useAgentExecutionStore().sessions[parentSessionId]).toMatchObject({
      loaded: true,
      loading: false,
    })
    expect(listAgentExecutions).toHaveBeenCalledOnce()
    expect(getAgentExecution).not.toHaveBeenCalled()
    expect(wrapper.get('.n-collapse-item').classes()).not.toContain(
      'n-collapse-item--active',
    )

    useAgentExecutionStore().upsertSummary({
      ...execution,
      updatedAt: '2026-08-01T00:00:01.000Z',
    })
    await wrapper.vm.$nextTick()
    expect(getAgentExecution).not.toHaveBeenCalled()
    expect(wrapper.get('.n-collapse-item').classes()).not.toContain(
      'n-collapse-item--active',
    )

    await wrapper.get('.n-collapse-item__header-main').trigger('click')
    await flushPromises()
    expect(getAgentExecution).toHaveBeenCalledOnce()
    expect(wrapper.get('.n-collapse-item').classes()).toContain(
      'n-collapse-item--active',
    )
    expect(wrapper.text()).toContain('运行时间')
    expect(wrapper.get('.agent-execution-tool-count').text()).toContain('1')
    expect(wrapper.text()).toContain('The review is in progress.')
    expect(wrapper.text()).not.toContain('Review the current repository.')
    expect(wrapper.text()).not.toContain(
      'Inspect the implementation carefully.',
    )
    expect(wrapper.findAll('.tool-call-card')).toHaveLength(0)
    expect(wrapper.findAll('.agent-execution-reasoning')).toHaveLength(0)
    expect(wrapper.findAll('.message-status')).toHaveLength(0)
    wrapper.unmount()
  })

  it('shows the active execution count without switching to Agents', () => {
    useAgentExecutionStore().upsertSummary(execution)
    const wrapper = mount(ArtifactPanel, {
      props: { activeTab: 'files' },
      global: {
        plugins: [i18n],
        stubs: {
          AgentsTab: true,
          DiffTab: true,
          FilesTab: true,
          PlanTab: true,
        },
      },
    })

    const agentsLabel = wrapper
      .findAll('.artifact-tab-label')
      .find((label) => label.text().includes('Agents'))
    expect(agentsLabel?.text()).toContain('1')
    expect(wrapper.props('activeTab')).toBe('files')
    wrapper.unmount()
  })

  it('loads a completed execution when the user expands it', async () => {
    const completed = {
      ...execution,
      status: 'completed' as const,
      completedAt: timestamp,
    }
    const listAgentExecutions = vi.fn(async () =>
      success({
        page: {
          schemaVersion: 1 as const,
          records: [completed],
          hasMore: false as const,
        },
      }),
    )
    const getAgentExecution = vi.fn(async () =>
      success({ detail: { ...detail, summary: completed } }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listAgentExecutions,
        getAgentExecution,
      } as Partial<AgentApi> as AgentApi,
    })
    const wrapper = mount(AgentsTab, {
      global: { plugins: [i18n] },
    })
    await vi.waitFor(() =>
      expect(useAgentExecutionStore().sessions[parentSessionId]?.loaded).toBe(
        true,
      ),
    )
    await wrapper.vm.$nextTick()
    expect(getAgentExecution).not.toHaveBeenCalled()

    await wrapper.get('.n-collapse-item__header-main').trigger('click')
    await flushPromises()
    expect(getAgentExecution).toHaveBeenCalledOnce()
    expect(wrapper.get('.agent-execution-tool-count').text()).toContain('1')
    expect(wrapper.text()).toContain('The review is in progress.')
    expect(wrapper.findAll('.tool-call-card')).toHaveLength(0)
    wrapper.unmount()
  })
})
