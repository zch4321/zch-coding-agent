import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { ProjectId, SessionId } from '../../shared/ids'
import { useAgentReplicaStore } from './agent-replica'

/** Tracks project-scoped file invalidations without making the active project an event owner. */
export const useWorkspaceFilesStore = defineStore('workspace-files', () => {
  const replica = useAgentReplicaStore()
  const revisions = ref<Record<string, number>>({})
  const pendingSessions = new Set<SessionId>()

  /** Returns the current invalidation generation for one project. */
  function revision(projectId: ProjectId | undefined): number {
    return projectId ? (revisions.value[projectId] ?? 0) : 0
  }

  /** Invalidates only the project identified by the event's durable owner. */
  function markDirty(projectId: ProjectId): void {
    revisions.value[projectId] = revision(projectId) + 1
  }

  /** Defers events whose Session commit has not yet reached the replica. */
  function invalidateSession(sessionId: SessionId): void {
    const session = replica.sessions.find(
      (candidate) => candidate.id === sessionId,
    )
    if (session) markDirty(session.projectId)
    else {
      pendingSessions.add(sessionId)
      // Unknown/deleted Sessions cannot keep an unbounded queue; entering a panel refreshes it.
      if (pendingSessions.size > 256)
        pendingSessions.delete(pendingSessions.values().next().value!)
    }
  }

  watch(
    () => replica.sessions,
    () => {
      for (const id of pendingSessions) {
        const session = replica.sessions.find(
          (candidate) => candidate.id === id,
        )
        if (!session) continue
        pendingSessions.delete(id)
        markDirty(session.projectId)
      }
    },
  )
  watch(
    () => replica.projects,
    (projects) => {
      const ids = new Set(projects.map((project) => project.id))
      for (const id of Object.keys(revisions.value))
        if (!ids.has(id as ProjectId)) delete revisions.value[id]
    },
  )
  return { revisions, revision, markDirty, invalidateSession }
})
