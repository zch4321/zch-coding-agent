// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type { CallId, RunId, SessionId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import ApprovalCard from './ApprovalCard.vue'

const sessionId = 'session:approval-card' as SessionId
const runId = 'run:approval-card' as RunId

beforeEach(() => {
  setActivePinia(createPinia())
  setAppLocale('zh-CN')
  useAgentReplicaStore().selectedSessionId = sessionId
  const overlay = useAgentRuntimeStore().ensureOverlay(sessionId)
  overlay.runId = runId
  overlay.status = 'awaiting_approval'
  overlay.approval = {
    runId,
    callId: 'call:approval-card' as CallId,
    kind: 'tool',
    tool: 'apply_patch',
    args: { path: 'src/app.ts', patch: 'x'.repeat(4000) },
    reason: 'Update the application',
    signals: [{ code: 'write', severity: 'warning', detail: 'Writes a file' }],
    rememberable: false,
    expiresAt: '2026-08-01T01:00:00.000Z',
    status: 'requested',
    order: 1,
  }
})

afterEach(() => {
  Reflect.deleteProperty(window, 'agentApi')
  document.body.innerHTML = ''
})

describe('ApprovalCard', () => {
  it('keeps details in a dedicated scrolling body between fixed regions', () => {
    const wrapper = mount(ApprovalCard, {
      props: { projectName: 'timeline-project' },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('.approval-card').element.children).toHaveLength(3)
    expect(wrapper.get('.approval-header').text()).toContain('apply_patch')
    expect(wrapper.get('.approval-card-body').text()).toContain(
      'Update the application',
    )
    expect(wrapper.get('.approval-card-body').classes()).toContain(
      'n-scrollbar',
    )
    expect(wrapper.get('.approval-actions').text()).toContain('批准')
    wrapper.unmount()
  })

  it('renders a dedicated Swarm review instead of raw task JSON', () => {
    const overlay = useAgentRuntimeStore().ensureOverlay(sessionId)
    overlay.approval = {
      ...overlay.approval!,
      tool: 'swarm_run',
      args: {
        sharedContext:
          'npm run check\nexitCode: 0\nAll deterministic checks passed.',
        tasks: [
          {
            name: 'Architecture review',
            task: 'Inspect module boundaries and report risks.',
            requiredCapability: 'strong',
            agentCount: 2,
            toolAccess: 'readonly',
          },
          {
            name: 'Test review',
            task: 'Inspect deterministic test coverage.',
            requiredCapability: 'light',
            agentCount: 1,
            toolAccess: 'inherit',
          },
        ],
      },
      reason: 'Run independent reviews',
    }
    const wrapper = mount(ApprovalCard, {
      props: { projectName: 'timeline-project' },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('.approval-header').text()).toContain('启动 Swarm')
    expect(wrapper.get('.swarm-approval-warning').text()).toContain(
      '额外的模型请求和费用',
    )
    expect(wrapper.get('.approval-meta').text()).toContain('Agent 总数')
    expect(wrapper.get('.approval-meta').text()).toContain('3')
    expect(wrapper.get('.swarm-approval-shared-context').text()).toContain(
      'All deterministic checks passed.',
    )
    expect(wrapper.findAll('.swarm-approval-tasks .n-list-item')).toHaveLength(
      2,
    )
    expect(wrapper.get('.swarm-approval-tasks').text()).toContain(
      'Architecture review',
    )
    expect(wrapper.get('.swarm-approval-tasks').text()).toContain('强')
    expect(wrapper.find('.approval-args').exists()).toBe(false)
    wrapper.unmount()
  })

  it('removes the current card after the serial approval is accepted', async () => {
    const decideApproval = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { decideApproval } as unknown as AgentApi,
    })
    const wrapper = mount(ApprovalCard, {
      props: { projectName: 'timeline-project' },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.approval-actions button').trigger('click')
    await flushPromises()

    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        runId,
        callId: 'call:approval-card',
        decision: 'allow',
      }),
    )
    expect(wrapper.find('.approval-card').exists()).toBe(false)
    wrapper.unmount()
  })
})
