import { randomUUID } from 'node:crypto'
import type { ProjectId, RunId, SessionId } from '../../shared/ids'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionRecord } from '../../shared/session'
import type { TraceCaptureStatus } from '../../shared/trace'
import type { SessionManager } from '../session/session-manager'
import { ApplicationError } from './application-error'
import type { DurableExecutionStatePort } from './durable-execution-state-port'
import type { ProjectRuntimeGuard, ProjectService } from './project-service'
import type { SessionRuntimeGuard, SessionService } from './session-service'

type LifecyclePhase =
  | 'reserved'
  | 'loading'
  | 'live'
  | 'mutating'
  | 'releasing'
  | 'evicting'
  | 'invalid'

interface LifecycleEntry {
  phase: LifecyclePhase
  ownerToken: string
  ownerRequestId?: string
  projectId?: ProjectId
  operationToken?: string
  loading?: Promise<void>
  teardown?: Promise<void>
}

/** Registers and resolves live session context entries. */
export class LiveSessionContextRegistry
  implements SessionRuntimeGuard, ProjectRuntimeGuard
{
  readonly #manager: SessionManager
  readonly #sessions: SessionService
  readonly #projects: ProjectService
  readonly #executionState: DurableExecutionStatePort
  readonly #onSessionEvicted: (sessionId: SessionId) => void
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #entries = new Map<SessionId, LifecycleEntry>()
  readonly #projectEvictions = new Map<ProjectId, string>()

  constructor(options: {
    manager: SessionManager
    sessions: SessionService
    projects: ProjectService
    executionState: DurableExecutionStatePort
    onSessionEvicted?: (sessionId: SessionId) => void
    onDiagnostic?: (message: string, error?: unknown) => void
  }) {
    this.#manager = options.manager
    this.#sessions = options.sessions
    this.#projects = options.projects
    this.#executionState = options.executionState
    this.#onSessionEvicted = options.onSessionEvicted ?? (() => undefined)
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Reserves new. */
  reserveNew(
    sessionId: SessionId,
    projectId: ProjectId,
    ownerRequestId: string,
  ): string {
    const existing = this.#entries.get(sessionId)
    if (
      existing?.phase === 'reserved' &&
      existing.ownerRequestId === ownerRequestId &&
      existing.projectId === projectId
    ) {
      return existing.ownerToken
    }
    if (existing || this.#projectEvictions.has(projectId)) {
      throw new ApplicationError(
        'CONFLICT',
        'Candidate Session lifecycle is already reserved',
      )
    }
    const ownerToken = randomUUID()
    this.#entries.set(sessionId, {
      phase: 'reserved',
      ownerToken,
      ownerRequestId,
      projectId,
    })
    return ownerToken
  }

  /** Returns or updates adopt new state. */
  adoptNew(
    sessionId: SessionId,
    projectId: ProjectId,
    ownerToken: string,
  ): void {
    const entry = this.#requireOwner(sessionId, ownerToken)
    if (entry.phase !== 'reserved' || entry.projectId !== projectId) {
      throw new ApplicationError(
        'CONFLICT',
        'Candidate Session reservation is no longer valid',
      )
    }
    entry.phase = 'live'
    delete entry.ownerRequestId
  }

  /** Releases owned. */
  async releaseOwned(sessionId: SessionId, ownerToken: string): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (!entry || entry.ownerToken !== ownerToken) return
    await this.#scheduleTeardown(sessionId, entry)
  }

  /** Ensures loaded. */
  async ensureLoaded(sessionId: SessionId): Promise<void> {
    const existing = this.#entries.get(sessionId)
    if (existing?.phase === 'live' && this.#manager.hasLiveSession(sessionId)) {
      return
    }
    if (existing?.phase === 'loading' && existing.loading) {
      return existing.loading
    }
    if (existing?.teardown) {
      await existing.teardown
      return this.ensureLoaded(sessionId)
    }
    if (existing) {
      throw new ApplicationError(
        'CONFLICT',
        `Session lifecycle is ${existing.phase}`,
      )
    }

    const entry: LifecycleEntry = {
      phase: 'loading',
      ownerToken: randomUUID(),
    }
    this.#entries.set(sessionId, entry)
    const loading = this.#load(sessionId, entry)
    entry.loading = loading
    return loading
  }

  /** Validates session idle and throws when it is invalid. */
  assertSessionIdle(sessionId: SessionId): void {
    const entry = this.#entries.get(sessionId)
    if (entry && entry.phase !== 'live') {
      throw new ApplicationError(
        'CONFLICT',
        `Session lifecycle is ${entry.phase}`,
      )
    }
    this.#assertManagerSessionIdle(sessionId)
  }

  /** Validates project idle and throws when it is invalid. */
  assertProjectIdle(projectId: ProjectId): void {
    if (this.#projectEvictions.has(projectId)) {
      throw new ApplicationError('CONFLICT', 'Project lifecycle is evicting')
    }
    for (const [sessionId, entry] of this.#entries) {
      if (
        (entry.phase === 'loading' || entry.phase === 'mutating') &&
        entry.projectId === undefined
      ) {
        throw new ApplicationError(
          'CONFLICT',
          `A Session lifecycle is ${entry.phase}`,
        )
      }
      if (entry.projectId !== projectId) continue
      if (entry.phase !== 'live') {
        throw new ApplicationError(
          'CONFLICT',
          `Session lifecycle is ${entry.phase}`,
        )
      }
      this.#assertManagerSessionIdle(sessionId)
    }
  }

  /** Reserves session mutation. */
  reserveSessionMutation(sessionId: SessionId): string {
    const entry = this.#entries.get(sessionId)
    if (entry && entry.phase !== 'live') {
      throw new ApplicationError(
        'CONFLICT',
        `Session lifecycle is ${entry.phase}`,
      )
    }
    this.#assertManagerSessionMutationIdle(sessionId)
    const operationToken = randomUUID()
    if (entry) {
      entry.phase = 'mutating'
      entry.operationToken = operationToken
    } else {
      this.#entries.set(sessionId, {
        phase: 'mutating',
        ownerToken: randomUUID(),
        operationToken,
      })
    }
    return operationToken
  }

  /** Binds session mutation project. */
  bindSessionMutationProject(
    sessionId: SessionId,
    operationToken: string,
    projectId: ProjectId,
  ): void {
    const entry = this.#entries.get(sessionId)
    if (
      !entry ||
      entry.phase !== 'mutating' ||
      entry.operationToken !== operationToken ||
      (entry.projectId !== undefined && entry.projectId !== projectId) ||
      this.#projectEvictions.has(projectId)
    ) {
      throw new ApplicationError(
        'CONFLICT',
        'Session mutation lifecycle ownership changed',
      )
    }
    entry.projectId = projectId
  }

  /** Releases session mutation. */
  releaseSessionMutation(sessionId: SessionId, operationToken: string): void {
    const entry = this.#entries.get(sessionId)
    if (
      !entry ||
      entry.phase !== 'mutating' ||
      entry.operationToken !== operationToken
    ) {
      return
    }
    delete entry.operationToken
    if (this.#manager.hasLiveSession(sessionId)) entry.phase = 'live'
    else this.#entries.delete(sessionId)
  }

  /** Reserves session eviction. */
  reserveSessionEviction(sessionId: SessionId): string {
    const entry = this.#entries.get(sessionId)
    if (entry && entry.phase !== 'live') {
      throw new ApplicationError(
        'CONFLICT',
        `Session lifecycle is ${entry.phase}`,
      )
    }
    this.#assertManagerSessionIdle(sessionId)
    const operationToken = randomUUID()
    if (entry) {
      entry.phase = 'evicting'
      entry.operationToken = operationToken
    } else {
      this.#entries.set(sessionId, {
        phase: 'evicting',
        ownerToken: operationToken,
        operationToken,
      })
    }
    return operationToken
  }

  /** Cancels session eviction. */
  cancelSessionEviction(sessionId: SessionId, operationToken: string): void {
    const entry = this.#entries.get(sessionId)
    if (
      !entry ||
      entry.phase !== 'evicting' ||
      entry.operationToken !== operationToken
    ) {
      return
    }
    delete entry.operationToken
    if (this.#manager.hasLiveSession(sessionId)) entry.phase = 'live'
    else this.#entries.delete(sessionId)
  }

  /** Releases session. */
  async releaseSession(
    sessionId: SessionId,
    operationToken?: string,
  ): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (operationToken) {
      if (
        !entry ||
        entry.phase !== 'evicting' ||
        entry.operationToken !== operationToken
      ) {
        return
      }
    } else {
      this.assertSessionIdle(sessionId)
    }
    if (!entry) {
      this.#onSessionEvicted(sessionId)
      return
    }
    await this.#scheduleTeardown(sessionId, entry)
  }

  /** Reserves project eviction. */
  reserveProjectEviction(projectId: ProjectId): string {
    this.assertProjectIdle(projectId)
    const operationToken = randomUUID()
    this.#projectEvictions.set(projectId, operationToken)
    for (const entry of this.#entries.values()) {
      if (entry.projectId !== projectId || entry.phase !== 'live') continue
      entry.phase = 'evicting'
      entry.operationToken = operationToken
    }
    return operationToken
  }

  /** Cancels project eviction. */
  cancelProjectEviction(projectId: ProjectId, operationToken: string): void {
    if (this.#projectEvictions.get(projectId) !== operationToken) return
    this.#projectEvictions.delete(projectId)
    for (const entry of this.#entries.values()) {
      if (
        entry.projectId === projectId &&
        entry.phase === 'evicting' &&
        entry.operationToken === operationToken
      ) {
        entry.phase = 'live'
        delete entry.operationToken
      }
    }
  }

  /** Evicts idle project. */
  async evictIdleProject(
    projectId: ProjectId,
    operationToken?: string,
  ): Promise<void> {
    if (
      operationToken &&
      this.#projectEvictions.get(projectId) !== operationToken
    ) {
      return
    }
    if (!operationToken) {
      operationToken = this.reserveProjectEviction(projectId)
    }
    const sessions = [...this.#entries.entries()].flatMap(
      ([sessionId, entry]) =>
        entry.projectId === projectId &&
        entry.phase === 'evicting' &&
        entry.operationToken === operationToken
          ? [[sessionId, entry] as const]
          : [],
    )
    for (const [sessionId, entry] of sessions) {
      await this.#scheduleTeardown(sessionId, entry)
    }
    if (this.#projectEvictions.get(projectId) === operationToken) {
      this.#projectEvictions.delete(projectId)
    }
  }

  /** Returns a snapshot of the current state. */
  snapshot(sessionId: SessionId): ActiveRunPublicSnapshot | undefined {
    return this.#manager.activeRunSnapshot(sessionId)
  }

  /** Returns the logging capture state for a currently loaded Session. */
  traceCaptureStatus(sessionId: SessionId): TraceCaptureStatus | undefined {
    return this.#manager.traceCaptureStatus(sessionId)
  }

  /** Applies session record. */
  applySessionRecord(record: SessionRecord): void {
    const entry = this.#entries.get(record.id)
    this.#manager.applyDurableSessionRecord(record)
    if (entry?.phase === 'live' && this.#manager.hasLiveSession(record.id)) {
      this.#executionState.applyRecord(record.id, record, entry.ownerToken)
    }
  }

  /** Returns or updates invalidate state. */
  invalidate(sessionId: SessionId, runId?: RunId): void {
    const entry = this.#entries.get(sessionId)
    if (!entry) return
    entry.phase = 'invalid'
    const settle = runId
      ? this.#manager
          .waitForRunSettled(sessionId, runId)
          .catch((error) =>
            this.#onDiagnostic(
              `Invalid Session ${sessionId} failed to settle`,
              error,
            ),
          )
      : Promise.resolve()
    void this.#scheduleTeardown(sessionId, entry, settle)
  }

  /** Releases all owned resources. */
  async dispose(): Promise<void> {
    const loading = [...this.#entries.values()].flatMap((entry) =>
      entry.loading ? [entry.loading] : [],
    )
    await Promise.allSettled(loading)
    for (const [sessionId, entry] of [...this.#entries]) {
      if (this.#manager.hasActiveRun(sessionId)) continue
      await this.releaseOwned(sessionId, entry.ownerToken)
    }
  }

  async #load(sessionId: SessionId, entry: LifecycleEntry): Promise<void> {
    try {
      const durable = await this.#sessions.loadRuntimeState(
        sessionId,
        [],
        (record) => {
          const current = this.#requireOwner(sessionId, entry.ownerToken)
          if (
            current.phase !== 'loading' ||
            this.#projectEvictions.has(record.projectId)
          ) {
            throw new ApplicationError(
              'CONFLICT',
              'Session cannot load during lifecycle eviction',
            )
          }
          current.projectId = record.projectId
        },
      )
      if (durable.record.lifecycle !== 'active') {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Archived Session cannot start a Run',
        )
      }
      const project = await this.#projects.get(durable.record.projectId)
      this.#executionState.registerExisting(durable.record, entry.ownerToken)
      await this.#manager.restoreSession({
        record: durable.record,
        workspace: project.path,
        history: durable.activeHistory,
      })
      const latest = await this.#sessions.getRecord(sessionId)
      const current = this.#requireOwner(sessionId, entry.ownerToken)
      if (
        current.phase !== 'loading' ||
        latest.lifecycle !== 'active' ||
        latest.revision !== durable.record.revision ||
        latest.projectId !== durable.record.projectId
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Session changed while its runtime context was loading',
        )
      }
      current.phase = 'live'
      delete current.loading
    } catch (error) {
      await this.#cleanupFailedLoad(sessionId, entry.ownerToken)
      throw error
    }
  }

  async #cleanupFailedLoad(
    sessionId: SessionId,
    ownerToken: string,
  ): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (!entry || entry.ownerToken !== ownerToken) return
    if (this.#manager.hasLiveSession(sessionId)) {
      await this.#manager
        .closeSession(sessionId)
        .catch((error) =>
          this.#onDiagnostic(
            `Failed to close partially loaded Session ${sessionId}`,
            error,
          ),
        )
    }
    this.#executionState.forget(sessionId, ownerToken)
    this.#entries.delete(sessionId)
  }

  async #closeOwnedContext(
    sessionId: SessionId,
    entry: LifecycleEntry,
  ): Promise<void> {
    try {
      if (this.#manager.hasLiveSession(sessionId)) {
        await this.#manager
          .closeSession(sessionId)
          .catch((error) =>
            this.#onDiagnostic(
              `Session ${sessionId} runtime cleanup failed after durable commit`,
              error,
            ),
          )
      }
      this.#executionState.forget(sessionId, entry.ownerToken)
    } finally {
      if (this.#entries.get(sessionId) === entry) {
        this.#entries.delete(sessionId)
      }
      this.#onSessionEvicted(sessionId)
    }
  }

  async #scheduleTeardown(
    sessionId: SessionId,
    entry: LifecycleEntry,
    before: Promise<unknown> = Promise.resolve(),
  ): Promise<void> {
    if (entry.teardown) return entry.teardown
    entry.phase = 'releasing'
    entry.teardown = before.then(() =>
      this.#closeOwnedContext(sessionId, entry),
    )
    return entry.teardown
  }

  #assertManagerSessionIdle(sessionId: SessionId): void {
    this.#assertManagerSessionMutationIdle(sessionId)
    if (this.#manager.hasOpenTerminals(sessionId)) {
      throw new ApplicationError('CONFLICT', 'Session has an open terminal')
    }
  }

  #assertManagerSessionMutationIdle(sessionId: SessionId): void {
    if (this.#manager.hasActiveRun(sessionId)) {
      throw new ApplicationError('CONFLICT', 'Session has an active Run')
    }
    if (this.#manager.hasUnsettledSideEffects(sessionId)) {
      throw new ApplicationError(
        'CONFLICT',
        'Session has an unfinished side effect',
      )
    }
  }

  #requireOwner(sessionId: SessionId, ownerToken: string): LifecycleEntry {
    const entry = this.#entries.get(sessionId)
    if (!entry || entry.ownerToken !== ownerToken) {
      throw new ApplicationError(
        'CONFLICT',
        'Session lifecycle ownership changed',
      )
    }
    return entry
  }
}
