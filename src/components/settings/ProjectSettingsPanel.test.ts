// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type { ProjectId, SessionId } from '../../../shared/ids'
import type { ProjectRecord } from '../../../shared/project'
import type { SessionRecord } from '../../../shared/session'
import { i18n } from '../../i18n'
import { useAgentExecutionStore } from '../../stores/agent-executions'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'

const firstProjectId = 'project:settings-first' as ProjectId
const secondProjectId = 'project:settings-second' as ProjectId
const firstSessionId = 'session:settings-first' as SessionId
const secondSessionId = 'session:settings-second' as SessionId
const timestamp = '2026-08-02T00:00:00.000Z'

/** Creates one durable Project fixture for the settings list. */
function project(id: ProjectId, name: string, path: string): ProjectRecord {
  return {
    schemaVersion: 1,
    id,
    name,
    path,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/** Creates one active Session fixture owned by a Project. */
function session(
  id: SessionId,
  projectId: ProjectId,
  title: string,
): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    title,
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
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/** Finds a rendered button by its visible label. */
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

describe('ProjectSettingsPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    i18n.global.locale.value = 'zh-CN'
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('lists every Project, blocks busy removal, and falls back after removing the current Project', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const firstProject = project(
      firstProjectId,
      'First project',
      'F:/workspace/first',
    )
    const secondProject = project(
      secondProjectId,
      'Second project',
      'F:/workspace/second',
    )
    const firstSession = session(
      firstSessionId,
      firstProjectId,
      'First conversation',
    )
    const secondSession = session(
      secondSessionId,
      secondProjectId,
      'Second conversation',
    )
    secondSession.permissionMode = 'confirm'
    const removeProject = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        commit: {
          schemaVersion: 1 as const,
          cursor: {
            schemaVersion: 1 as const,
            backendInstanceId: 'backend:project-settings',
            sequence: 1,
          },
          topic: 'project.changed' as const,
          change: { projects: [secondProject] },
        },
      },
    }))
    const getSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        snapshot: {
          schemaVersion: 1 as const,
          session: secondSession,
          messagePage: {
            schemaVersion: 1 as const,
            sessionId: secondSessionId,
            records: [],
            hasMore: false as const,
          },
        },
      },
    }))
    const listAgentExecutions = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        page: {
          schemaVersion: 1 as const,
          records: [],
          hasMore: false as const,
        },
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        removeProject,
        getSession,
        listAgentExecutions,
      } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [firstProject, secondProject]
    replica.sessions = [firstSession, secondSession]
    replica.selectedProjectId = firstProjectId
    replica.selectedSessionId = firstSessionId
    replica.searchHits = [
      { session: firstSession, match: { kind: 'title', snippet: 'First' } },
      { session: secondSession, match: { kind: 'title', snippet: 'Second' } },
    ]
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:project-settings',
      sequence: 0,
    }
    const runtime = useAgentRuntimeStore()
    runtime.startPendingSessionId = secondSessionId
    runtime.mode = 'yolo'
    runtime.input = 'stale draft'
    runtime.ensureOverlay(firstSessionId)
    const executions = useAgentExecutionStore()
    executions.ensureSession(firstSessionId)

    const wrapper = mount(ProjectSettingsPanel, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })
    await nextTick()

    const rows = wrapper.findAll('.project-settings-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('First project')
    expect(rows[0]!.text()).toContain('活跃对话：1')
    expect(rows[1]!.get('button').attributes('disabled')).toBeDefined()

    await rows[0]!.get('button').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('从应用移除项目？')
    expect(document.body.textContent).toContain('F:/workspace/first')

    findButton('从应用移除', true).click()
    await flushPromises()

    expect(removeProject).toHaveBeenCalledWith({
      version: 1,
      projectId: firstProjectId,
      expectedRevision: 1,
    })
    expect(getSession).toHaveBeenCalledWith({
      version: 1,
      sessionId: secondSessionId,
    })
    expect(replica.selectedProjectId).toBe(secondProjectId)
    expect(replica.selectedSessionId).toBe(secondSessionId)
    expect(runtime.mode).toBe('confirm')
    expect(runtime.input).toBe('')
    expect(runtime.overlays[firstSessionId]).toBeUndefined()
    expect(executions.sessions[firstSessionId]).toBeUndefined()
    expect(replica.searchHits.map((hit) => hit.session.id)).toEqual([
      secondSessionId,
    ])
    expect(wrapper.text()).not.toContain('First project')
    expect(wrapper.text()).toContain('Second project')
    expect(wrapper.text()).toContain('当前')
    wrapper.unmount()
  })

  it('keeps the Project and confirmation open when removal fails', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const onlyProject = project(
      firstProjectId,
      'Only project',
      'F:/workspace/only',
    )
    const removeProject = vi.fn(async () => ({
      version: 1 as const,
      ok: false as const,
      error: {
        code: 'PRECONDITION_FAILED' as const,
        message: 'Project is busy',
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { removeProject } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [onlyProject]
    replica.selectedProjectId = firstProjectId

    const wrapper = mount(ProjectSettingsPanel, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })
    await wrapper.get('.project-settings-row button').trigger('click')
    await nextTick()
    findButton('从应用移除', true).click()
    await flushPromises()

    expect(removeProject).toHaveBeenCalledTimes(1)
    expect(replica.projects).toEqual([onlyProject])
    expect(document.body.textContent).toContain('从应用移除项目？')
    expect(document.body.textContent).toContain('Only project')
    wrapper.unmount()
  })

  it('removes a non-current Project without changing the current selection', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const firstProject = project(
      firstProjectId,
      'Current project',
      'F:/workspace/current',
    )
    const secondProject = project(
      secondProjectId,
      'Inactive project',
      'F:/workspace/inactive',
    )
    const removeProject = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        version: 1 as const,
        commit: {
          schemaVersion: 1 as const,
          cursor: {
            schemaVersion: 1 as const,
            backendInstanceId: 'backend:project-settings',
            sequence: 1,
          },
          topic: 'project.changed' as const,
          change: { projects: [firstProject] },
        },
      },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { removeProject } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [firstProject, secondProject]
    replica.selectedProjectId = firstProjectId
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:project-settings',
      sequence: 0,
    }

    const wrapper = mount(ProjectSettingsPanel, {
      attachTo: document.body,
      global: { plugins: [pinia, i18n] },
    })
    await wrapper
      .findAll('.project-settings-row')[1]!
      .get('button')
      .trigger('click')
    await nextTick()
    findButton('从应用移除', true).click()
    await flushPromises()

    expect(removeProject).toHaveBeenCalledWith({
      version: 1,
      projectId: secondProjectId,
      expectedRevision: 1,
    })
    expect(replica.selectedProjectId).toBe(firstProjectId)
    expect(wrapper.text()).toContain('Current project')
    expect(wrapper.text()).not.toContain('Inactive project')
    wrapper.unmount()
  })
})
