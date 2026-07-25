import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  BackendEventCursor,
  DurableCommitEnvelope,
  SessionSearchHit,
} from '../../shared/domain-state-api'
import type { FileChangeSummary } from '../../shared/file-change'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionRecord } from '../../shared/session'

function upsertById<T extends { id: string }>(records: T[], record: T): T[] {
  const next = records.filter((candidate) => candidate.id !== record.id)
  next.push(structuredClone(record))
  return next
}

function mergeMessages(
  current: MessageRecord[],
  records: readonly MessageRecord[],
): MessageRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]))
  for (const record of records) byId.set(record.id, structuredClone(record))
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}

export const useAgentReplicaStore = defineStore('agent-replica', {
  state: () => ({
    projects: [] as ProjectRecord[],
    sessions: [] as SessionRecord[],
    selectedProjectId: undefined as ProjectId | undefined,
    selectedSessionId: undefined as SessionId | undefined,
    messagesBySessionId: {} as Record<string, MessageRecord[]>,
    fileChangesBySessionId: {} as Record<string, FileChangeSummary[]>,
    runtimeBySessionId: {} as Record<
      string,
      ActiveRunPublicSnapshot | undefined
    >,
    messageHasMoreBySessionId: {} as Record<string, boolean>,
    fileChangeHasMoreBySessionId: {} as Record<string, boolean>,
    cursor: undefined as BackendEventCursor | undefined,
    searchHits: [] as SessionSearchHit[],
    loading: false,
    error: '',
  }),
  getters: {
    selectedProject(state): ProjectRecord | undefined {
      return state.projects.find(
        (project) => project.id === state.selectedProjectId,
      )
    },
    selectedSession(state): SessionRecord | undefined {
      return state.sessions.find(
        (session) => session.id === state.selectedSessionId,
      )
    },
    selectedMessages(state): MessageRecord[] {
      return state.selectedSessionId
        ? (state.messagesBySessionId[state.selectedSessionId] ?? [])
        : []
    },
    selectedFileChanges(state): FileChangeSummary[] {
      return state.selectedSessionId
        ? (state.fileChangesBySessionId[state.selectedSessionId] ?? [])
        : []
    },
    selectedRuntime(state): ActiveRunPublicSnapshot | undefined {
      return state.selectedSessionId
        ? state.runtimeBySessionId[state.selectedSessionId]
        : undefined
    },
  },
  actions: {
    async bootstrap(preferredProjectPath?: string) {
      const api = window.agentApi
      if (!api) return false
      this.loading = true
      const result = await api.getBootstrap({ version: IPC_VERSION })
      this.loading = false
      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      const previousProjectId = this.selectedProjectId
      const previousSessionId = this.selectedSessionId
      this.projects = structuredClone(result.value.projects)
      this.sessions = structuredClone(result.value.sessions)
      this.cursor = structuredClone(result.value.cursor)
      this.selectedProjectId =
        this.projects.find((project) => project.id === previousProjectId)?.id ??
        this.projects.find((project) => project.path === preferredProjectPath)
          ?.id ??
        this.projects[0]?.id
      this.selectedSessionId =
        this.sessions.find(
          (session) =>
            session.id === previousSessionId &&
            session.projectId === this.selectedProjectId &&
            session.lifecycle === 'active',
        )?.id ??
        this.sessions.find(
          (session) =>
            session.projectId === this.selectedProjectId &&
            session.lifecycle === 'active',
        )?.id
      this.pruneCaches()
      if (this.selectedSessionId) await this.loadSession(this.selectedSessionId)
      this.error = ''
      return true
    },
    async selectProject(projectId: ProjectId, selectLatest = true) {
      if (!this.projects.some((project) => project.id === projectId)) return
      this.selectedProjectId = projectId
      if (selectLatest) {
        this.selectedSessionId = this.sessions.find(
          (session) =>
            session.projectId === projectId && session.lifecycle === 'active',
        )?.id
      }
      if (this.selectedSessionId) await this.loadSession(this.selectedSessionId)
    },
    async selectSession(sessionId: SessionId) {
      const session = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (!session || session.lifecycle !== 'active') return false
      this.selectedProjectId = session.projectId
      this.selectedSessionId = session.id
      return this.loadSession(session.id)
    },
    beginDraft(projectId: ProjectId) {
      this.selectedProjectId = projectId
      this.selectedSessionId = undefined
    },
    async loadSession(sessionId: SessionId) {
      const api = window.agentApi
      if (!api) return false
      const result = await api.getSession({ version: IPC_VERSION, sessionId })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      const snapshot = result.value.snapshot
      this.sessions = upsertById(this.sessions, snapshot.session)
      this.messagesBySessionId[sessionId] = structuredClone(
        snapshot.messagePage.records,
      )
      this.messageHasMoreBySessionId[sessionId] = snapshot.messagePage.hasMore
      this.runtimeBySessionId[sessionId] = snapshot.runtime
        ? structuredClone(snapshot.runtime)
        : undefined
      return true
    },
    async loadOlderMessages(targetSessionId?: SessionId) {
      const sessionId = targetSessionId ?? this.selectedSessionId
      const api = window.agentApi
      if (
        !api ||
        !sessionId ||
        this.messageHasMoreBySessionId[sessionId] === false
      ) {
        return
      }
      const first = this.messagesBySessionId[sessionId]?.[0]
      const result = await api.listMessages({
        version: IPC_VERSION,
        sessionId,
        ...(first ? { beforeSeq: first.seq } : {}),
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return
      }
      this.messagesBySessionId[sessionId] = mergeMessages(
        this.messagesBySessionId[sessionId] ?? [],
        result.value.page.records,
      )
      this.messageHasMoreBySessionId[sessionId] = result.value.page.hasMore
    },
    async loadFileChanges(targetSessionId?: SessionId) {
      const sessionId = targetSessionId ?? this.selectedSessionId
      const api = window.agentApi
      if (!api || !sessionId) return
      const result = await api.listFileChanges({
        version: IPC_VERSION,
        sessionId,
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return
      }
      this.fileChangesBySessionId[sessionId] = structuredClone(
        result.value.page.records,
      )
      this.fileChangeHasMoreBySessionId[sessionId] = result.value.page.hasMore
    },
    async search(text: string, projectId?: ProjectId) {
      const api = window.agentApi
      const query = text.trim()
      if (!api || !query) {
        this.searchHits = []
        return
      }
      const result = await api.searchSessions({
        version: IPC_VERSION,
        text: query,
        ...(projectId ? { projectId } : {}),
        limit: 100,
      })
      if (result.ok) this.searchHits = structuredClone(result.value.hits)
      else this.error = result.error.message
    },
    async reconcile(commit: DurableCommitEnvelope) {
      const current = this.cursor
      if (
        !current ||
        current.backendInstanceId !== commit.cursor.backendInstanceId ||
        commit.cursor.sequence > current.sequence + 1
      ) {
        await this.bootstrap(this.selectedProject?.path)
        return 'resynced' as const
      }
      if (commit.cursor.sequence <= current.sequence) {
        return 'duplicate' as const
      }
      this.cursor = structuredClone(commit.cursor)

      if (commit.topic === 'project.changed') {
        const previous = new Set(this.projects.map((project) => project.id))
        this.projects = structuredClone(commit.change.projects)
        const available = new Set(this.projects.map((project) => project.id))
        for (const projectId of previous) {
          if (available.has(projectId)) continue
          this.sessions = this.sessions.filter(
            (session) => session.projectId !== projectId,
          )
        }
        if (this.selectedProjectId && !available.has(this.selectedProjectId)) {
          this.selectedProjectId = this.projects[0]?.id
          this.selectedSessionId = undefined
        }
        this.pruneCaches()
        return 'applied' as const
      }

      if (commit.topic === 'session.changed') {
        const incoming = commit.change.session
        const existing = this.sessions.find(
          (session) => session.id === incoming.id,
        )
        if (existing && incoming.revision > existing.revision + 1) {
          await this.loadSession(incoming.id)
          return 'resynced' as const
        }
        this.sessions = upsertById(this.sessions, incoming)
        const change = commit.change.messageChange
        if (change.mode === 'upsert') {
          this.messagesBySessionId[incoming.id] = mergeMessages(
            this.messagesBySessionId[incoming.id] ?? [],
            change.records,
          )
        } else if (
          change.mode === 'invalidate' ||
          change.mode === 'invalidate_all'
        ) {
          delete this.messagesBySessionId[incoming.id]
          delete this.messageHasMoreBySessionId[incoming.id]
          if (incoming.id === this.selectedSessionId) {
            await this.loadSession(incoming.id)
          }
        }
        if (
          incoming.lifecycle === 'archived' &&
          incoming.id === this.selectedSessionId
        ) {
          this.selectedSessionId = this.sessions.find(
            (session) =>
              session.projectId === incoming.projectId &&
              session.lifecycle === 'active',
          )?.id
          if (this.selectedSessionId) {
            await this.loadSession(this.selectedSessionId)
          }
        }
        return 'applied' as const
      }

      const change = commit.change
      if (change.mode === 'invalidate_all') {
        this.fileChangesBySessionId = {}
        this.fileChangeHasMoreBySessionId = {}
        return 'applied' as const
      }
      const sessionId = change.sessionId
      this.fileChangesBySessionId[sessionId] = upsertById(
        this.fileChangesBySessionId[sessionId] ?? [],
        change.fileChange,
      )
      return 'applied' as const
    },
    pruneCaches() {
      const sessionIds = new Set(this.sessions.map((session) => session.id))
      for (const key of Object.keys(this.messagesBySessionId)) {
        if (!sessionIds.has(key as SessionId)) {
          delete this.messagesBySessionId[key]
          delete this.fileChangesBySessionId[key]
          delete this.runtimeBySessionId[key]
        }
      }
    },
  },
})
