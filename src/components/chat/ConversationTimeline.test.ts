// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import ConversationTimeline from './ConversationTimeline.vue'

const sessionId = 'session:timeline-scroll' as SessionId
const runId = 'run:timeline-scroll' as RunId
const nativeScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo',
)

beforeEach(() => {
  setActivePinia(createPinia())
  setAppLocale('zh-CN')
  useAgentReplicaStore().selectedSessionId = sessionId
  const overlay = useAgentRuntimeStore().ensureOverlay(sessionId)
  overlay.runId = runId
  overlay.status = 'running_tools'
  overlay.tools = [
    {
      callId: 'call:timeline-scroll' as CallId,
      runId,
      tool: 'read_file',
      args: { path: 'README.md' },
      reason: 'Read the file',
      status: 'completed',
      result: { status: 'ok' },
      order: 1,
    },
  ]
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (nativeScrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', nativeScrollTo)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  }
  document.body.innerHTML = ''
})

describe('ConversationTimeline', () => {
  it('follows output when a collapsed timeline group expands', async () => {
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'timeline-project' },
      attachTo: document.body,
      global: { plugins: [i18n] },
    })
    const sentinel = wrapper.get('.conversation-bottom-sentinel')
      .element as HTMLElement
    expect(wrapper.get('.conversation-scroll').classes()).toContain(
      'n-scrollbar',
    )
    const scrollIntoView = vi.fn()
    Object.defineProperty(sentinel, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    await wrapper
      .get('.tool-call-group .n-collapse-item__header-main')
      .trigger('click')
    await flushPromises()

    expect(scrollIntoView).toHaveBeenCalled()
    wrapper.unmount()
  })
})
