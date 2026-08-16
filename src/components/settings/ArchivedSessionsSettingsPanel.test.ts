// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type { ProjectId, SessionId } from '../../../shared/ids'
import type { SessionRecord } from '../../../shared/session'
import { i18n } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import ArchivedSessionsSettingsPanel from './ArchivedSessionsSettingsPanel.vue'

const projectId = 'project:archive-settings' as ProjectId
const firstSessionId = 'session:archive-settings-z' as SessionId
const secondSessionId = 'session:archive-settings-a' as SessionId
const timestamp = '2026-07-26T04:00:00.000Z'

function archivedSession(id: SessionId, title: string): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    title,
    titleSource: 'user',
    lifecycle: 'archived',
    archivedAt: timestamp,
    permissionMode: 'readonly',
    modelSelection: {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'off',
    },
    goal: null,
    plan: null,
    revision: 2,
    lastSeq: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function activeSession(record: SessionRecord): SessionRecord {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    titleSource: 'user',
    lifecycle: 'active',
    permissionMode: record.permissionMode,
    modelSelection: record.modelSelection,
    goal: record.goal,
    plan: record.plan,
    revision: record.revision + 1,
    lastSeq: record.lastSeq,
    createdAt: record.createdAt,
    updatedAt: timestamp,
  }
}

function findButton(text: string, last = false): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')].filter(
    (candidate) => candidate.textContent?.trim() === text,
  )
  const button = last ? buttons.at(-1) : buttons[0]
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

describe('ArchivedSessionsSettingsPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    i18n.global.locale.value = 'zh-CN'
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('lists, restores, and permanently deletes archived Sessions', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const first = archivedSession(firstSessionId, 'First archived session')
    const second = archivedSession(secondSessionId, 'Second archived session')
    const listSessions = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        page: {
          schemaVersion: 1 as const,
          records: [first, second],
          hasMore: false as const,
        },
      },
    }))
    const restoreSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        commit: {
          schemaVersion: 1 as const,
          cursor: {
            schemaVersion: 1 as const,
            backendInstanceId: 'backend:archive-settings',
            sequence: 1,
          },
          topic: 'session.changed' as const,
          change: {
            session: activeSession(first),
            messageChange: { mode: 'none' as const },
          },
        },
      },
    }))
    const deleteSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        commit: {
          schemaVersion: 1 as const,
          cursor: {
            schemaVersion: 1 as const,
            backendInstanceId: 'backend:archive-settings',
            sequence: 2,
          },
          topic: 'session.removed' as const,
          change: { sessionId: secondSessionId, projectId },
        },
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listSessions,
        restoreSession,
        deleteSession,
      } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [
      {
        schemaVersion: 1,
        id: projectId,
        name: 'Archive project',
        path: 'F:/workspace/archive-project',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:archive-settings',
      sequence: 0,
    }

    const wrapper = mount(ArchivedSessionsSettingsPanel, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })
    await flushPromises()
    expect(document.body.textContent).toContain('First archived session')
    expect(document.body.textContent).toContain('Second archived session')

    findButton('恢复').click()
    await flushPromises()
    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: firstSessionId }),
    )
    expect(document.body.textContent).not.toContain('First archived session')

    findButton('永久删除', true).click()
    await nextTick()
    expect(document.body.textContent).toContain('永久删除归档对话？')
    findButton('永久删除', true).click()
    await flushPromises()
    expect(deleteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: secondSessionId }),
    )
    expect(document.body.textContent).not.toContain('Second archived session')
    wrapper.unmount()
  })
})
