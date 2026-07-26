import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { IPC_VERSION } from '../../shared/channels'
import type {
  BackendEventCursor,
  DurableCommitEnvelope,
  SessionSearchHit,
} from '../../shared/domain-state-api'
import type {
  FileChangeListCursor,
  FileChangeSummary,
} from '../../shared/file-change'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionListCursor, SessionRecord } from '../../shared/session'
import type { TraceCaptureStatus } from '../../shared/trace'

let bootstrapInFlight: Promise<boolean> | undefined

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

function mergeSessions(
  current: SessionRecord[],
  records: readonly SessionRecord[],
): SessionRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]))
  for (const record of records) byId.set(record.id, structuredClone(record))
  return [...byId.values()].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
  )
}

function mergeFileChanges(
  current: FileChangeSummary[],
  records: readonly FileChangeSummary[],
): FileChangeSummary[] {
  const byId = new Map(current.map((record) => [record.id, record]))
  for (const record of records) byId.set(record.id, structuredClone(record))
  return [...byId.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  )
}

/** Stores the server-authoritative durable Project, Session, and page caches. */
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
    traceCaptureBySessionId: {} as Record<
      string,
      TraceCaptureStatus | undefined
    >,
    sessionHasMore: false,
    sessionNextBefore: undefined as SessionListCursor | undefined,
    messageHasMoreBySessionId: {} as Record<string, boolean>,
    messageNextBeforeSeqBySessionId: {} as Record<string, number | undefined>,
    fileChangeHasMoreBySessionId: {} as Record<string, boolean>,
    fileChangeNextBeforeBySessionId: {} as Record<
      string,
      FileChangeListCursor | undefined
    >,
    cursor: undefined as BackendEventCursor | undefined,
    searchHits: [] as SessionSearchHit[],
    searchGeneration: 0,
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
    selectedTraceCapture(state): TraceCaptureStatus | undefined {
      return state.selectedSessionId
        ? state.traceCaptureBySessionId[state.selectedSessionId]
        : undefined
    },
    selectedMessageHasMore(state): boolean {
      return state.selectedSessionId
        ? (state.messageHasMoreBySessionId[state.selectedSessionId] ?? false)
        : false
    },
    selectedFileChangeHasMore(state): boolean {
      return state.selectedSessionId
        ? (state.fileChangeHasMoreBySessionId[state.selectedSessionId] ?? false)
        : false
    },
  },
  actions: {
    /** Coalesces concurrent bootstrap requests into one backend round trip. */
    async bootstrap(preferredProjectPath?: string): Promise<boolean> {
      if (bootstrapInFlight) return bootstrapInFlight
      const pending = this.performBootstrap(preferredProjectPath)
      bootstrapInFlight = pending
      try {
        return await pending
      } finally {
        if (bootstrapInFlight === pending) bootstrapInFlight = undefined
      }
    },
    /** Replaces durable list state from a single backend bootstrap snapshot. */
    async performBootstrap(preferredProjectPath?: string): Promise<boolean> {
      const api = window.agentApi
      if (!api) return false
      this.loading = true
      const result = await api
        .getBootstrap({ version: IPC_VERSION })
        .finally(() => {
          this.loading = false
        })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      const previousProjectId = this.selectedProjectId
      const previousSessionId = this.selectedSessionId
      const selectedBeforeBootstrap = this.sessions.find(
        (session) => session.id === previousSessionId,
      )
      const previousSession = selectedBeforeBootstrap
        ? structuredClone(toRaw(selectedBeforeBootstrap))
        : undefined
      this.projects = structuredClone(result.value.projects)
      this.sessions = structuredClone(result.value.sessionPage.records)
      this.sessionHasMore = result.value.sessionPage.hasMore
      this.sessionNextBefore = result.value.sessionPage.hasMore
        ? structuredClone(result.value.sessionPage.nextBefore)
        : undefined
      this.cursor = structuredClone(result.value.cursor)
      this.selectedProjectId =
        this.projects.find((project) => project.id === previousProjectId)?.id ??
        this.projects.find((project) => project.path === preferredProjectPath)
          ?.id ??
        this.projects[0]?.id
      const pageSelection = this.sessions.find(
        (session) =>
          session.id === previousSessionId &&
          session.projectId === this.selectedProjectId &&
          session.lifecycle === 'active',
      )
      const restorePrevious =
        !pageSelection &&
        previousSession?.projectId === this.selectedProjectId &&
        previousSession.lifecycle === 'active'
      if (restorePrevious) {
        this.sessions = mergeSessions(this.sessions, [previousSession])
      }
      this.selectedSessionId =
        pageSelection?.id ??
        (restorePrevious ? previousSession.id : undefined) ??
        this.sessions.find(
          (session) =>
            session.projectId === this.selectedProjectId &&
            session.lifecycle === 'active',
        )?.id
      this.pruneCaches()
      if (
        this.selectedSessionId &&
        !(await this.loadSession(this.selectedSessionId))
      ) {
        if (!restorePrevious) return false
        this.sessions = this.sessions.filter(
          (session) => session.id !== previousSession.id,
        )
        this.selectedSessionId = this.sessions.find(
          (session) =>
            session.projectId === this.selectedProjectId &&
            session.lifecycle === 'active',
        )?.id
        this.pruneCaches()
        if (
          this.selectedSessionId &&
          !(await this.loadSession(this.selectedSessionId))
        ) {
          return false
        }
      }
      this.error = ''
      return true
    },
    /** Loads the next older active Session page into the sidebar cache. */
    async loadOlderSessions(): Promise<boolean> {
      const api = window.agentApi
      const before = this.sessionNextBefore
      if (!api || !this.sessionHasMore || !before) return false
      const result = await api.listSessions({
        version: IPC_VERSION,
        lifecycle: 'active',
        before: {
          updatedAt: before.updatedAt,
          sessionId: before.sessionId,
        },
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      this.sessions = mergeSessions(this.sessions, result.value.page.records)
      this.sessionHasMore = result.value.page.hasMore
      this.sessionNextBefore = result.value.page.hasMore
        ? structuredClone(result.value.page.nextBefore)
        : undefined
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
    /** Selects a cached Session or loads an uncached search target by id. */
    async selectSession(sessionId: SessionId): Promise<boolean> {
      let session = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (!session) {
        if (!(await this.loadSession(sessionId))) return false
        session = this.sessions.find((candidate) => candidate.id === sessionId)
      }
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
      const current = this.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (current && current.revision > snapshot.session.revision) {
        return true
      }
      this.sessions = upsertById(this.sessions, snapshot.session)
      this.messagesBySessionId[sessionId] = structuredClone(
        snapshot.messagePage.records,
      )
      this.messageHasMoreBySessionId[sessionId] = snapshot.messagePage.hasMore
      this.messageNextBeforeSeqBySessionId[sessionId] = snapshot.messagePage
        .hasMore
        ? snapshot.messagePage.nextBeforeSeq
        : undefined
      this.runtimeBySessionId[sessionId] = snapshot.runtime
        ? structuredClone(snapshot.runtime)
        : undefined
      this.traceCaptureBySessionId[sessionId] = snapshot.traceCapture
        ? structuredClone(snapshot.traceCapture)
        : undefined
      return true
    },
    /** Prepends one older Message page without changing durable ordering. */
    async loadOlderMessages(targetSessionId?: SessionId): Promise<boolean> {
      const sessionId = targetSessionId ?? this.selectedSessionId
      const api = window.agentApi
      if (
        !api ||
        !sessionId ||
        this.messageHasMoreBySessionId[sessionId] === false
      ) {
        return false
      }
      const beforeSeq = this.messageNextBeforeSeqBySessionId[sessionId]
      const result = await api.listMessages({
        version: IPC_VERSION,
        sessionId,
        ...(beforeSeq ? { beforeSeq } : {}),
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      this.messagesBySessionId[sessionId] = mergeMessages(
        this.messagesBySessionId[sessionId] ?? [],
        result.value.page.records,
      )
      this.messageHasMoreBySessionId[sessionId] = result.value.page.hasMore
      this.messageNextBeforeSeqBySessionId[sessionId] = result.value.page
        .hasMore
        ? result.value.page.nextBeforeSeq
        : undefined
      return true
    },
    /** Replaces the cached FileChange page for a Session. */
    async loadFileChanges(targetSessionId?: SessionId): Promise<boolean> {
      const sessionId = targetSessionId ?? this.selectedSessionId
      const api = window.agentApi
      if (!api || !sessionId) return false
      const result = await api.listFileChanges({
        version: IPC_VERSION,
        sessionId,
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      this.fileChangesBySessionId[sessionId] = structuredClone(
        result.value.page.records,
      )
      this.fileChangeHasMoreBySessionId[sessionId] = result.value.page.hasMore
      this.fileChangeNextBeforeBySessionId[sessionId] = result.value.page
        .hasMore
        ? structuredClone(result.value.page.nextBefore)
        : undefined
      return true
    },
    /** Appends one older FileChange page using its stable compound cursor. */
    async loadOlderFileChanges(targetSessionId?: SessionId): Promise<boolean> {
      const sessionId = targetSessionId ?? this.selectedSessionId
      const api = window.agentApi
      const before = sessionId
        ? this.fileChangeNextBeforeBySessionId[sessionId]
        : undefined
      if (
        !api ||
        !sessionId ||
        !this.fileChangeHasMoreBySessionId[sessionId] ||
        !before
      ) {
        return false
      }
      const result = await api.listFileChanges({
        version: IPC_VERSION,
        sessionId,
        before: {
          createdAt: before.createdAt,
          fileChangeId: before.fileChangeId,
        },
        limit: 200,
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      this.fileChangesBySessionId[sessionId] = mergeFileChanges(
        this.fileChangesBySessionId[sessionId] ?? [],
        result.value.page.records,
      )
      this.fileChangeHasMoreBySessionId[sessionId] = result.value.page.hasMore
      this.fileChangeNextBeforeBySessionId[sessionId] = result.value.page
        .hasMore
        ? structuredClone(result.value.page.nextBefore)
        : undefined
      return true
    },
    /** Searches active Sessions and upserts uncached hit summaries. */
    async search(text: string, projectId?: ProjectId): Promise<void> {
      const api = window.agentApi
      const query = text.trim()
      const generation = ++this.searchGeneration
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
      if (generation !== this.searchGeneration) return
      if (result.ok) {
        this.searchHits = structuredClone(result.value.hits)
        this.sessions = mergeSessions(
          this.sessions,
          result.value.hits.map((hit) => hit.session),
        )
      } else {
        this.error = result.error.message
      }
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
        this.sessions = mergeSessions(this.sessions, [incoming])
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
          delete this.messageNextBeforeSeqBySessionId[incoming.id]
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

      if (commit.topic === 'session.removed') {
        const { sessionId, projectId } = commit.change
        this.sessions = this.sessions.filter(
          (session) => session.id !== sessionId,
        )
        this.searchHits = this.searchHits.filter(
          (hit) => hit.session.id !== sessionId,
        )
        if (this.selectedSessionId === sessionId) {
          this.selectedSessionId = this.sessions.find(
            (session) =>
              session.projectId === projectId && session.lifecycle === 'active',
          )?.id
        }
        this.pruneCaches()
        if (this.selectedSessionId) {
          await this.loadSession(this.selectedSessionId)
        }
        return 'applied' as const
      }

      const change = commit.change
      if (change.mode === 'invalidate_all') {
        this.fileChangesBySessionId = {}
        this.fileChangeHasMoreBySessionId = {}
        this.fileChangeNextBeforeBySessionId = {}
        return 'applied' as const
      }
      const sessionId = change.sessionId
      this.fileChangesBySessionId[sessionId] = mergeFileChanges(
        this.fileChangesBySessionId[sessionId] ?? [],
        [change.fileChange],
      )
      return 'applied' as const
    },
    /** Removes every cache whose Session is no longer represented locally. */
    pruneCaches() {
      const sessionIds = new Set(this.sessions.map((session) => session.id))
      const keys = new Set([
        ...Object.keys(this.messagesBySessionId),
        ...Object.keys(this.fileChangesBySessionId),
        ...Object.keys(this.runtimeBySessionId),
        ...Object.keys(this.traceCaptureBySessionId),
      ])
      for (const key of keys) {
        if (!sessionIds.has(key as SessionId)) {
          delete this.messagesBySessionId[key]
          delete this.fileChangesBySessionId[key]
          delete this.runtimeBySessionId[key]
          delete this.traceCaptureBySessionId[key]
          delete this.messageHasMoreBySessionId[key]
          delete this.messageNextBeforeSeqBySessionId[key]
          delete this.fileChangeHasMoreBySessionId[key]
          delete this.fileChangeNextBeforeBySessionId[key]
        }
      }
    },
  },
})
