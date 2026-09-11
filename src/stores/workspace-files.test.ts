// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CallId, ProjectId, RunId, SessionId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useWorkspaceFilesStore } from './workspace-files'

const projectA = 'project:a' as ProjectId
const projectB = 'project:b' as ProjectId
const sessionB = 'session:b' as SessionId
beforeEach(() => setActivePinia(createPinia()))

describe('workspace invalidation ownership', () => {
  it('routes file Tool results and terminal Run invalidations to their owning project', async () => {
    const replica = useAgentReplicaStore()
    replica.selectedProjectId = projectA
    replica.sessions = [{ id: sessionB, projectId: projectB } as SessionRecord]
    const runtime = useAgentRuntimeStore()
    const files = useWorkspaceFilesStore()
    const base = {
      schemaVersion: 1 as const,
      ts: '2026-09-11T00:00:00.000Z',
      sessionId: sessionB,
      runId: 'run:b' as RunId,
      callId: 'call:b' as CallId,
    }
    runtime.handleAgentEvent({
      ...base,
      seq: 1,
      type: 'tool.proposed',
      tool: 'write_file',
      args: {},
      reason: 'write',
    })
    runtime.handleAgentEvent({
      ...base,
      seq: 2,
      type: 'tool.completed',
      result: { status: 'ok', content: {} },
    })
    expect(files.revision(projectA)).toBe(0)
    expect(files.revision(projectB)).toBe(1)
    runtime.handleAgentEvent({
      schemaVersion: 1,
      ts: base.ts,
      seq: 3,
      sessionId: sessionB,
      runId: base.runId,
      type: 'run.status',
      status: 'completed',
    })
    await nextTick()
    expect(files.revision(projectA)).toBe(0)
    expect(files.revision(projectB)).toBe(2)
  })

  it('waits for a delayed owner record without refreshing the selected project or making extra IPC calls', async () => {
    const replica = useAgentReplicaStore()
    replica.selectedProjectId = projectA
    const files = useWorkspaceFilesStore()
    files.invalidateSession(sessionB)
    files.invalidateSession(sessionB)
    expect(files.revision(projectA)).toBe(0)
    replica.sessions = [{ id: sessionB, projectId: projectB } as SessionRecord]
    await nextTick()
    expect(files.revision(projectA)).toBe(0)
    expect(files.revision(projectB)).toBe(1)
  })
})
