// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import ConversationTimeline from './ConversationTimeline.vue'
import * as toolDisplay from './tool-result-display'

const sessionId = 'session:timeline-scroll' as SessionId
const runId = 'run:timeline-scroll' as RunId
const scrollTo = vi.fn()
const nativeScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo',
)

beforeEach(() => {
  scrollTo.mockClear()
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
    value: scrollTo,
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
    expect(wrapper.get('.conversation-scroll').classes()).toContain(
      'n-scrollbar',
    )
    await flushPromises()
    scrollTo.mockClear()

    await wrapper
      .get('.tool-call-group .n-collapse-item__header-main')
      .trigger('click')
    await flushPromises()

    expect(scrollTo).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps completed tool cards and their formatting untouched during CoT-only streaming', async () => {
    const overlay = useAgentRuntimeStore().ensureOverlay(sessionId)
    overlay.reasoning = 'Thinking'
    overlay.streamActivity = 'reasoning'
    const format = vi.spyOn(toolDisplay, 'formatToolResultDisplay')
    const cardUpdated = vi.fn()
    const wrapper = mount(ConversationTimeline, {
      props: { projectName: 'timeline-project' },
      attachTo: document.body,
      global: {
        plugins: [i18n],
        mixins: [
          {
            updated() {
              if (this.$options.__name === 'ToolCallCard') cardUpdated()
            },
          },
        ],
      },
    })
    await wrapper
      .get('.tool-call-group .n-collapse-item__header-main')
      .trigger('click')
    await wrapper
      .get('.tool-call-card .n-collapse-item__header-main')
      .trigger('click')
    await flushPromises()
    expect(format).toHaveBeenCalled()
    format.mockClear()
    cardUpdated.mockClear()
    scrollTo.mockClear()
    for (let index = 0; index < 100; index++) {
      overlay.reasoning += ' more thought'
      await flushPromises()
    }
    expect(format).not.toHaveBeenCalled()
    expect(cardUpdated).not.toHaveBeenCalled()
    // A folded thought does not change layout or request outer scrolling.
    expect(scrollTo).not.toHaveBeenCalled()
    await wrapper.get('.tool-result-json').trigger('wheel', { deltaY: -10 })
    expect(wrapper.find('.back-to-bottom').exists()).toBe(true)
    overlay.reasoning += ' still thinking'
    await flushPromises()
    expect(wrapper.find('.back-to-bottom').exists()).toBe(true)
    wrapper.unmount()
  })
})
