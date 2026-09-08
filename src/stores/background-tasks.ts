import { defineStore } from 'pinia'
import {
  backgroundTaskKey,
  compareBackgroundTasks,
  type BackgroundTask,
  type BackgroundTaskEvent,
  type BackgroundTaskTarget,
} from '../../shared/background-tasks'
import type { SessionId } from '../../shared/ids'
import type { RuntimeCursor } from '../../shared/runtime-cursor'
import { IPC_VERSION } from '../../shared/channels'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentExecutionStore } from './agent-executions'

interface BackgroundSessionView {
  records: BackgroundTask[]
  activeCount: number
  loaded: boolean
  loading: boolean
  hasMore: boolean
  nextBefore?: string
  error?: string
  requiredSequence: number
  refreshPending: boolean
}

interface StopRequest {
  pending: boolean
  accepted: boolean
  error?: string
}

/** Owns public-Session background lists and cancellation independently of bottom-terminal visibility. */
export const useBackgroundTaskStore = defineStore('background-tasks', {
  state: () => ({
    sessions: {} as Record<string, BackgroundSessionView>,
    stops: {} as Record<string, StopRequest>,
    backendInstanceId: undefined as string | undefined,
    retiredInstances: [] as string[],
  }),
  getters: {
    selectedView(state): BackgroundSessionView | undefined {
      const id = useAgentReplicaStore().selectedSessionId
      return id ? state.sessions[id] : undefined
    },
    selectedRecords(): BackgroundTask[] {
      return this.selectedView?.records ?? []
    },
    selectedActiveCount(): number {
      return this.selectedView?.activeCount ?? 0
    },
  },
  actions: {
    ensureSession(sessionId: SessionId): BackgroundSessionView {
      this.sessions[sessionId] ??= {
        records: [],
        activeCount: 0,
        loaded: false,
        loading: false,
        hasMore: false,
        requiredSequence: 0,
        refreshPending: false,
      }
      return this.sessions[sessionId]!
    },
    acceptCursor(cursor: RuntimeCursor): boolean {
      if (this.retiredInstances.includes(cursor.backendInstanceId)) return false
      if (
        this.backendInstanceId &&
        this.backendInstanceId !== cursor.backendInstanceId
      ) {
        this.retiredInstances = [
          ...this.retiredInstances,
          this.backendInstanceId,
        ].slice(-16)
        this.sessions = {}
        this.stops = {}
      }
      this.backendInstanceId = cursor.backendInstanceId
      useAgentExecutionStore().acceptCursor(cursor)
      return true
    },
    removeSession(sessionId: SessionId): void {
      delete this.sessions[sessionId]
    },
    async load(
      sessionId: SessionId,
      options: { append?: boolean; force?: boolean } = {},
    ): Promise<void> {
      const api = window.agentApi
      if (!api?.listBackgroundTasks) return
      let view = this.ensureSession(sessionId)
      if (view.loading) {
        if (options.force) view.refreshPending = true
        return
      }
      if (
        (view.loaded && !options.append && !options.force) ||
        (options.append && !view.hasMore)
      )
        return
      view.loading = true
      view.error = undefined
      try {
        const result = await api.listBackgroundTasks({
          version: IPC_VERSION,
          parentSessionId: sessionId,
          ...(options.append && view.nextBefore
            ? { before: view.nextBefore }
            : {}),
        })
        if (this.sessions[sessionId] !== view) return
        if (!result.ok) {
          view.error = result.error.message
          return
        }
        const page = result.value
        if (!this.acceptCursor(page.cursor)) return
        view = this.ensureSession(sessionId)
        if (page.cursor.sequence < view.requiredSequence) {
          view.refreshPending = true
          return
        }
        const merged = new Map(
          (options.append ? view.records : []).map((task) => [
            backgroundTaskKey(task),
            task,
          ]),
        )
        for (const task of page.records) {
          merged.set(backgroundTaskKey(task), structuredClone(task))
          if (task.kind === 'agent')
            useAgentExecutionStore().upsertSummary(task.summary, page.cursor)
        }
        view.records = [...merged.values()].sort(compareBackgroundTasks)
        view.activeCount = page.activeCount
        view.hasMore = page.hasMore
        view.nextBefore = page.nextBefore
        view.loaded = true
      } catch (error) {
        if (this.sessions[sessionId] === view)
          view.error = error instanceof Error ? error.message : String(error)
      } finally {
        view.loading = false
        if (this.sessions[sessionId] === view && view.refreshPending) {
          view.refreshPending = false
          void this.load(sessionId, { force: true })
        }
      }
    },
    handleEvent(event: BackgroundTaskEvent): void {
      if (!this.acceptCursor(event.cursor)) return
      const view = this.ensureSession(event.parentSessionId)
      view.requiredSequence = Math.max(
        view.requiredSequence,
        event.cursor.sequence,
      )
      if (
        view.loaded ||
        event.parentSessionId === useAgentReplicaStore().selectedSessionId
      )
        void this.load(event.parentSessionId, { force: true })
    },
    async stop(
      parentSessionId: SessionId,
      target: BackgroundTaskTarget,
    ): Promise<void> {
      if (!this.backendInstanceId) await this.load(parentSessionId)
      const backendInstanceId = this.backendInstanceId
      const api = window.agentApi
      if (!backendInstanceId || !api) return
      const key =
        target.kind === 'terminal'
          ? `terminal:${target.terminalId}`
          : target.executionId
      if (this.stops[key]?.pending) return
      const request: StopRequest = { pending: true, accepted: false }
      this.stops[key] = request
      try {
        const result = await api.cancelBackgroundTask({
          version: IPC_VERSION,
          parentSessionId,
          backendInstanceId,
          target,
        })
        if (this.backendInstanceId !== backendInstanceId) return
        if (result.ok) this.stops[key]!.accepted = result.value.accepted
        else this.stops[key]!.error = result.error.message
      } catch (error) {
        if (this.backendInstanceId === backendInstanceId)
          this.stops[key]!.error =
            error instanceof Error ? error.message : String(error)
      } finally {
        if (this.backendInstanceId === backendInstanceId) {
          this.stops[key]!.pending = false
          await this.load(parentSessionId, { force: true })
        }
      }
    },
  },
})
