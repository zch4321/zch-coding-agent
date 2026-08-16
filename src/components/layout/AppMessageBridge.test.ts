// @vitest-environment jsdom

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectId, SessionId } from '../../../shared/ids'
import type { SessionRecord } from '../../../shared/session'
import { i18n } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useNotificationStore } from '../../stores/notifications'
import AppMessageBridge from './AppMessageBridge.vue'

const sessionId = 'session:background-notification' as SessionId

function host() {
  return mount(
    defineComponent({
      components: { AppMessageBridge, NMessageProvider },
      template:
        '<NMessageProvider placement="top"><AppMessageBridge /></NMessageProvider>',
    }),
    {
      attachTo: document.body,
      global: { plugins: [i18n] },
    },
  )
}

async function renderMessages(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

describe('AppMessageBridge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('expires warnings after ten seconds and keeps errors until closed', async () => {
    const wrapper = host()
    const notifications = useNotificationStore()
    notifications.warning({ code: 'WARN', message: 'Temporary warning' })
    notifications.error({ code: 'ERROR', message: 'Persistent error' })
    await renderMessages()

    expect(document.body.textContent).toContain('Temporary warning')
    expect(document.body.textContent).toContain('Persistent error')

    await vi.advanceTimersByTimeAsync(10_500)
    await renderMessages()
    expect(document.body.textContent).not.toContain('Temporary warning')
    expect(document.body.textContent).toContain('Persistent error')

    const close = document.querySelector<HTMLButtonElement>('.n-message__close')
    close?.click()
    await vi.advanceTimersByTimeAsync(500)
    await renderMessages()
    expect(document.body.textContent).not.toContain('Persistent error')
    wrapper.unmount()
  })

  it('shows at most five messages and queues the remainder', async () => {
    const wrapper = host()
    const notifications = useNotificationStore()
    for (let index = 0; index < 6; index += 1) {
      notifications.error({
        code: `ERROR_${index}`,
        message: `Persistent error ${index}`,
      })
    }
    await renderMessages()

    expect(document.querySelectorAll('.n-message')).toHaveLength(5)
    expect(notifications.activeKeys).toHaveLength(5)
    expect(notifications.pending).toHaveLength(1)
    wrapper.unmount()
  })

  it('prefixes a background Session title without changing selection', async () => {
    const replica = useAgentReplicaStore()
    replica.sessions = [
      {
        schemaVersion: 1,
        id: sessionId,
        projectId: 'project:notification' as ProjectId,
        title: 'Background task',
        titleSource: 'user',
        lifecycle: 'active',
        permissionMode: 'readonly',
        modelSelection: {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          reasoning: 'off',
        },
        goal: null,
        plan: null,
        revision: 1,
        lastSeq: 0,
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      } satisfies SessionRecord,
    ]
    const selected = 'session:selected' as SessionId
    replica.selectedSessionId = selected
    const wrapper = host()

    useNotificationStore().error({
      code: 'BACKGROUND_FAILED',
      message: 'Request failed.',
      sessionId,
    })
    await renderMessages()

    expect(document.body.textContent).toContain('Background task')
    expect(document.body.textContent).toContain('Request failed.')
    expect(replica.selectedSessionId).toBe(selected)
    wrapper.unmount()
  })
})
