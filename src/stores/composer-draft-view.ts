import { watch } from 'vue'
import type { useAgentReplicaStore } from './agent-replica'
import { useComposerDraftsStore, type DraftTarget } from './composer-drafts'
import type { ProjectId, SessionId } from '../../shared/ids'

type Replica = ReturnType<typeof useAgentReplicaStore>
const VIEW_KEY = 'composer-draft-view'

/** Resolves the composer owner from renderer selection, without storing draft data in the replica. */
export function selectedDraftTarget(replica: Replica): DraftTarget | undefined {
  return replica.selectedProjectId
    ? {
        projectId: replica.selectedProjectId,
        ...(replica.selectedSessionId
          ? { sessionId: replica.selectedSessionId }
          : {}),
      }
    : undefined
}

/** Restores the last composer, including a new-session placeholder or a Session outside the first page. */
export async function restoreComposerDraftView(
  replica: Replica,
): Promise<void> {
  const navigationRevision = replica.navigationRevision
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    const value: unknown = raw ? JSON.parse(raw) : undefined
    if (
      !value ||
      typeof value !== 'object' ||
      !('projectId' in value) ||
      typeof value.projectId !== 'string' ||
      !replica.projects.some((project) => project.id === value.projectId)
    )
      return
    if ('sessionId' in value && value.sessionId !== undefined) {
      if (typeof value.sessionId !== 'string') return
      const sessionId = value.sessionId as SessionId
      if (!(await replica.loadSession(sessionId))) return
      const session = replica.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (
        replica.navigationRevision !== navigationRevision ||
        !session ||
        session.projectId !== value.projectId ||
        session.lifecycle !== 'active'
      )
        return
      replica.selectedProjectId = session.projectId
      replica.selectedSessionId = session.id
    } else {
      replica.beginDraft(value.projectId as ProjectId)
    }
  } catch {
    /* Invalid or unavailable browser storage leaves the bootstrap selection intact. */
  }
}

/** Flushes on navigation and remembers the current composer for reload and application restart. */
export function trackComposerDraftView(replica: Replica): () => void {
  const drafts = useComposerDraftsStore()
  const persist = () => {
    drafts.flush()
    try {
      const target = selectedDraftTarget(replica)
      if (target) localStorage.setItem(VIEW_KEY, JSON.stringify(target))
      else localStorage.removeItem(VIEW_KEY)
    } catch {
      /* Selection persistence does not block navigation. */
    }
  }
  const stopFlush = watch(
    () => [replica.selectedProjectId, replica.selectedSessionId],
    drafts.flush,
    { flush: 'sync' },
  )
  const stopView = watch(
    () => [replica.selectedProjectId, replica.selectedSessionId],
    persist,
    { flush: 'post' },
  )
  persist()
  window.addEventListener('pagehide', persist)
  window.addEventListener('beforeunload', persist)
  return () => {
    persist()
    stopFlush()
    stopView()
    window.removeEventListener('pagehide', persist)
    window.removeEventListener('beforeunload', persist)
  }
}
