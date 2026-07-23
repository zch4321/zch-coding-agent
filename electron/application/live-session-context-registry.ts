import type { ProjectId, SessionId } from '../../shared/ids'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionRecord } from '../../shared/session'
import type { SessionManager } from '../session/session-manager'
import { ApplicationError } from './application-error'
import type { DurableExecutionStatePort } from './durable-execution-state-port'
import type { ProjectRuntimeGuard, ProjectService } from './project-service'
import type { SessionRuntimeGuard, SessionService } from './session-service'

export class LiveSessionContextRegistry
  implements SessionRuntimeGuard, ProjectRuntimeGuard
{
  readonly #manager: SessionManager
  readonly #sessions: SessionService
  readonly #projects: ProjectService
  readonly #executionState: DurableExecutionStatePort
  readonly #onSessionEvicted: (sessionId: SessionId) => void
  readonly #projectBySession = new Map<SessionId, ProjectId>()
  readonly #loading = new Map<SessionId, Promise<void>>()

  constructor(options: {
    manager: SessionManager
    sessions: SessionService
    projects: ProjectService
    executionState: DurableExecutionStatePort
    onSessionEvicted?: (sessionId: SessionId) => void
  }) {
    this.#manager = options.manager
    this.#sessions = options.sessions
    this.#projects = options.projects
    this.#executionState = options.executionState
    this.#onSessionEvicted = options.onSessionEvicted ?? (() => undefined)
  }

  async ensureLoaded(sessionId: SessionId): Promise<void> {
    if (this.#manager.hasLiveSession(sessionId)) return
    const loading = this.#loading.get(sessionId)
    if (loading) return loading
    const work = this.#load(sessionId).finally(() => {
      this.#loading.delete(sessionId)
    })
    this.#loading.set(sessionId, work)
    return work
  }

  adoptNew(sessionId: SessionId, projectId: ProjectId): void {
    this.#projectBySession.set(sessionId, projectId)
  }

  assertSessionIdle(sessionId: SessionId): void {
    if (this.#manager.hasActiveRun(sessionId)) {
      throw new ApplicationError('CONFLICT', 'Session has an active Run')
    }
    if (this.#manager.hasUnsettledSideEffects(sessionId)) {
      throw new ApplicationError(
        'CONFLICT',
        'Session has an unfinished side effect',
      )
    }
    if (this.#manager.hasOpenTerminals(sessionId)) {
      throw new ApplicationError('CONFLICT', 'Session has an open terminal')
    }
  }

  assertProjectIdle(projectId: ProjectId): void {
    for (const [sessionId, currentProjectId] of this.#projectBySession) {
      if (currentProjectId !== projectId) continue
      this.assertSessionIdle(sessionId)
    }
  }

  snapshot(sessionId: SessionId): ActiveRunPublicSnapshot | undefined {
    return this.#manager.activeRunSnapshot(sessionId)
  }

  applySessionRecord(record: SessionRecord): void {
    if (this.#manager.hasLiveSession(record.id)) {
      this.#executionState.registerExisting(record)
    }
    this.#manager.applyDurableSessionRecord(record)
  }

  async releaseSession(sessionId: SessionId): Promise<void> {
    this.assertSessionIdle(sessionId)
    if (this.#manager.hasLiveSession(sessionId)) {
      await this.#manager.closeSession(sessionId)
    }
    this.#executionState.forget(sessionId)
    this.#projectBySession.delete(sessionId)
    this.#onSessionEvicted(sessionId)
  }

  async evictIdleProject(projectId: ProjectId): Promise<void> {
    this.assertProjectIdle(projectId)
    const sessions = [...this.#projectBySession.entries()].flatMap(
      ([sessionId, currentProjectId]) =>
        currentProjectId === projectId ? [sessionId] : [],
    )
    for (const sessionId of sessions) await this.releaseSession(sessionId)
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#projectBySession.keys()]
    for (const sessionId of sessions) {
      if (!this.#manager.hasActiveRun(sessionId)) {
        await this.releaseSession(sessionId)
      }
    }
  }

  async #load(sessionId: SessionId): Promise<void> {
    const record = await this.#sessions.getRecord(sessionId)
    if (record.lifecycle !== 'active') {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Archived Session cannot start a Run',
      )
    }
    const [project, history] = await Promise.all([
      this.#projects.get(record.projectId),
      this.#sessions.listActiveHistory(sessionId),
    ])
    this.#executionState.registerExisting(record)
    try {
      await this.#manager.restoreSession({
        record,
        workspace: project.path,
        history,
      })
      this.#projectBySession.set(sessionId, record.projectId)
    } catch (error) {
      this.#executionState.forget(sessionId)
      throw error
    }
  }
}
