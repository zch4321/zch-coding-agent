// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { ProjectId } from '../../shared/ids'
import type { ProjectMetadataSnapshot } from '../../shared/project-model'
import type { ProjectRecord } from '../../shared/project'
import { useAgentProjectStore } from './agent-project'
import { useAgentReplicaStore } from './agent-replica'

const timestamp = '2026-07-26T00:00:00.000Z'
const projectAId = 'project:a' as ProjectId
const projectBId = 'project:b' as ProjectId

function projectRecord(id: ProjectId, path: string): ProjectRecord {
  return {
    schemaVersion: 1,
    id,
    path,
    name: id,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function snapshot(workspaceRoot: string): ProjectMetadataSnapshot {
  return {
    path: '.zch/project-model.json',
    gitIgnoreRecommended: false,
    project: {
      schemaVersion: 1,
      workspaceRoot,
      modules: [],
      storage: 'project-local',
      backendBindings: [],
      serena: {
        id: 'serena',
        enabled: false,
        command: 'serena',
        startupTimeoutMs: 15_000,
        toolTimeoutMs: 30_000,
        languages: [],
      },
      updatedAt: timestamp,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('agent project store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('ignores stale project metadata and backend status after selection changes', async () => {
    const projectA = deferred<Awaited<ReturnType<AgentApi['getProject']>>>()
    const projectB = deferred<Awaited<ReturnType<AgentApi['getProject']>>>()
    const getProject = vi.fn(
      async ({ projectId }: Parameters<AgentApi['getProject']>[0]) =>
        projectId === projectAId ? projectA.promise : projectB.promise,
    )
    const getProjectBackendStatus = vi.fn(
      async ({
        projectId,
      }: Parameters<AgentApi['getProjectBackendStatus']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: {
          statuses: [
            {
              backendId: String(projectId),
              backendKind: 'fallback' as const,
              state: 'ready' as const,
              capabilities: [],
              updatedAt: timestamp,
            },
          ],
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getProject,
        getProjectBackendStatus,
      } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [
      projectRecord(projectAId, 'F:/workspace/a'),
      projectRecord(projectBId, 'F:/workspace/b'),
    ]
    replica.selectedProjectId = projectAId
    const store = useAgentProjectStore()

    const loadA = store.loadProject('F:/workspace/a')
    replica.selectedProjectId = projectBId
    const loadB = store.loadProject('F:/workspace/b')
    projectB.resolve({
      version: 1,
      ok: true,
      value: snapshot('F:/workspace/b'),
    })
    await loadB
    projectA.resolve({
      version: 1,
      ok: true,
      value: snapshot('F:/workspace/a'),
    })
    await loadA

    expect(store.projectSnapshot?.project.workspaceRoot).toBe('F:/workspace/b')
    expect(store.backendStatuses).toEqual([
      expect.objectContaining({ backendId: projectBId }),
    ])
    expect(getProjectBackendStatus).toHaveBeenCalledTimes(1)
    expect(getProjectBackendStatus).toHaveBeenCalledWith({
      version: 1,
      projectId: projectBId,
    })
  })
})
