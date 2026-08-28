import type {
  DurableRunContinuePayload,
  DurableRunContinueResult,
  DurableRunRetryPayload,
  DurableRunRetryResult,
  DurableRunStartPayload,
  DurableRunStartResult,
  SessionCommitEnvelopeSchema,
} from '../../shared/domain-state-api'
import type { RunId, SessionId } from '../../shared/ids'
import { resolveManualContinuationTarget } from '../../shared/conversation-continuation'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionRecord } from '../../shared/session'
import type { Static } from '@sinclair/typebox'
import type { SessionManager } from '../session/session-manager'
import { canonicalHash } from '../session/canonical-history'
import { ApplicationError } from './application-error'
import type { DurableExecutionStatePort } from './durable-execution-state-port'
import type { LiveSessionContextRegistry } from './live-session-context-registry'
import type { ProjectService } from './project-service'
import type { SessionService } from './session-service'

const MAX_CACHED_RUN_STARTS = 1_000

type SessionCommitEnvelope = Static<typeof SessionCommitEnvelopeSchema>

/** Coordinates idempotent durable run starts and retries with live session ownership. */
export class DurableRunApplicationService {
  readonly #manager: SessionManager
  readonly #projects: ProjectService
  readonly #sessions: SessionService
  readonly #registry: LiveSessionContextRegistry
  readonly #executionState: DurableExecutionStatePort
  readonly #requests = new Map<
    string,
    {
      requestHash: string
      promise: Promise<DurableRunStartResult>
    }
  >()
  readonly #retryRequests = new Map<
    string,
    {
      requestHash: string
      promise: Promise<DurableRunRetryResult>
      settled: boolean
    }
  >()
  readonly #continueRequests = new Map<
    string,
    {
      requestHash: string
      promise: Promise<DurableRunContinueResult>
    }
  >()

  constructor(options: {
    manager: SessionManager
    projects: ProjectService
    sessions: SessionService
    registry: LiveSessionContextRegistry
    executionState: DurableExecutionStatePort
  }) {
    this.#manager = options.manager
    this.#projects = options.projects
    this.#sessions = options.sessions
    this.#registry = options.registry
    this.#executionState = options.executionState
  }

  /** Starts or reuses a durable run for a client request and commits its initial context. */
  start(input: DurableRunStartPayload): Promise<DurableRunStartResult> {
    const key = `${input.sessionId}\u0000${input.clientRequestId}`
    const requestHash = canonicalHash(input.message)
    const existing = this.#requests.get(key)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(
          new ApplicationError(
            'CONFLICT',
            'clientRequestId was already used for different message text',
          ),
        )
      }
      return existing.promise
    }
    const request = this.#reserveAndStart(input).catch((error) => {
      this.#requests.delete(key)
      throw error
    })
    this.#requests.set(key, { requestHash, promise: request })
    while (this.#requests.size > MAX_CACHED_RUN_STARTS) {
      const oldest = this.#requests.keys().next().value
      if (oldest === undefined) break
      this.#requests.delete(oldest)
    }
    return request
  }

  /** Removes cached run command results for a session after it is evicted. */
  evictRequestCacheForSession(sessionId: SessionId): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.#requests.keys()) {
      if (key.startsWith(prefix)) this.#requests.delete(key)
    }
    for (const [key, entry] of this.#retryRequests) {
      if (key.startsWith(prefix) && entry.settled) {
        this.#retryRequests.delete(key)
      }
    }
    for (const key of this.#continueRequests.keys()) {
      if (key.startsWith(prefix)) this.#continueRequests.delete(key)
    }
  }

  /** Retries a user message idempotently while coordinating with the live session context. */
  retry(input: DurableRunRetryPayload): Promise<DurableRunRetryResult> {
    const key = `${input.sessionId}\u0000${input.clientRequestId}`
    const requestHash = canonicalHash(input.userMessageId)
    const existing = this.#retryRequests.get(key)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(
          new ApplicationError(
            'CONFLICT',
            'clientRequestId was already used for a different retry target',
          ),
        )
      }
      return existing.promise
    }
    const entry = {
      requestHash,
      promise: undefined as unknown as Promise<DurableRunRetryResult>,
      settled: false,
    }
    const request = this.#retry(input).then(
      (result) => {
        entry.settled = true
        return result
      },
      (error: unknown) => {
        if (this.#retryRequests.get(key) === entry) {
          this.#retryRequests.delete(key)
        }
        throw error
      },
    )
    entry.promise = request
    this.#retryRequests.set(key, entry)
    while (this.#retryRequests.size > MAX_CACHED_RUN_STARTS) {
      const oldest = this.#retryRequests.keys().next().value
      if (oldest === undefined) break
      this.#retryRequests.delete(oldest)
    }
    return request
  }

  /** Continues an interrupted durable turn idempotently without adding input. */
  continue(
    input: DurableRunContinuePayload,
  ): Promise<DurableRunContinueResult> {
    const key = `${input.sessionId}\u0000${input.clientRequestId}`
    const requestHash = canonicalHash(String(input.expectedRevision))
    const existing = this.#continueRequests.get(key)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(
          new ApplicationError(
            'CONFLICT',
            'clientRequestId was already used for a different continuation',
          ),
        )
      }
      return existing.promise
    }
    const request = this.#continue(input).catch((error) => {
      this.#continueRequests.delete(key)
      throw error
    })
    this.#continueRequests.set(key, { requestHash, promise: request })
    while (this.#continueRequests.size > MAX_CACHED_RUN_STARTS) {
      const oldest = this.#continueRequests.keys().next().value
      if (oldest === undefined) break
      this.#continueRequests.delete(oldest)
    }
    return request
  }

  async #continue(
    input: DurableRunContinuePayload,
  ): Promise<DurableRunContinueResult> {
    const durable = await this.#sessions.loadRuntimeState(input.sessionId)
    const current = durable.record
    if (current.lifecycle !== 'active') {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Archived Session cannot continue a Run',
      )
    }
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationError('CONFLICT', 'Session revision has changed', {
        details: {
          currentRevision: current.revision,
          currentLastSeq: current.lastSeq,
        },
      })
    }
    if (!resolveManualContinuationTarget(durable.activeHistory)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The Session history does not end at a continuable turn',
      )
    }
    await this.#registry.ensureLoaded(input.sessionId)
    const loaded = this.#executionState.record(input.sessionId)
    if (!loaded) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding was not loaded',
      )
    }
    if (loaded.revision !== input.expectedRevision) {
      throw new ApplicationError('CONFLICT', 'Session revision has changed', {
        details: {
          currentRevision: loaded.revision,
          currentLastSeq: loaded.lastSeq,
        },
      })
    }
    const runId = this.#manager.continueRun({
      sessionId: input.sessionId,
      clientRequestId: input.clientRequestId,
    })
    return {
      version: 1,
      runId,
      runtime:
        this.#manager.activeRunSnapshot(input.sessionId) ??
        emptyRuntimeSnapshot(input.sessionId, runId),
    }
  }

  async #retry(input: DurableRunRetryPayload): Promise<DurableRunRetryResult> {
    const user = await this.#sessions.getOriginalVisibleUser(
      input.sessionId,
      input.userMessageId,
    )
    const command = await this.#sessions.rewind({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      messageId: user.id,
      boundary: 'after_message',
    })
    let runId: RunId
    try {
      await this.#registry.ensureLoaded(input.sessionId)
      runId = this.#manager.retryRun({
        sessionId: input.sessionId,
        userMessageId: user.id,
        clientRequestId: input.clientRequestId,
      })
    } catch (error) {
      const normalized =
        error instanceof ApplicationError
          ? error
          : new ApplicationError(
              'PERSISTENCE_FAILURE',
              'The retried Session could not start',
              { cause: error },
            )
      throw new ApplicationError(normalized.code, normalized.message, {
        details: {
          ...normalized.details,
          mutationSucceeded: true,
        },
        cause: normalized.cause ?? error,
      })
    }
    const runtime =
      this.#manager.activeRunSnapshot(input.sessionId) ??
      emptyRuntimeSnapshot(input.sessionId, runId)
    return {
      version: 1,
      commit: command.commit,
      runId,
      runtime,
    }
  }

  async #reserveAndStart(
    input: DurableRunStartPayload,
  ): Promise<DurableRunStartResult> {
    let ownerToken: string | undefined
    if (input.kind === 'new_session') {
      const requestHash = canonicalHash(input.message)
      const duplicate = await this.#sessions.lookupRequest(
        input.sessionId,
        input.clientRequestId,
        requestHash,
      )
      if (duplicate) {
        return {
          version: 1,
          outcome: 'deduplicated',
          session: duplicate.session,
          userMessage: duplicate.userMessage,
          ...(this.#manager.activeRunSnapshot(input.sessionId)
            ? { runtime: this.#manager.activeRunSnapshot(input.sessionId) }
            : {}),
        }
      }
      ownerToken = this.#registry.reserveNew(
        input.sessionId,
        input.projectId,
        input.clientRequestId,
      )
    }
    try {
      return await this.#start(input, ownerToken)
    } catch (error) {
      if (ownerToken) {
        await this.#registry.releaseOwned(input.sessionId, ownerToken)
      }
      throw error
    }
  }

  async #start(
    input: DurableRunStartPayload,
    ownerToken?: string,
  ): Promise<DurableRunStartResult> {
    if (
      input.kind === 'new_session' &&
      /^\/compact(?:\s|$)/iu.test(input.message.trimStart())
    ) {
      if (ownerToken) {
        await this.#registry.releaseOwned(input.sessionId, ownerToken)
      }
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Cannot compact a draft before its first durable message',
      )
    }
    const requestHash = canonicalHash(input.message)
    const duplicate = await this.#sessions.lookupRequest(
      input.sessionId,
      input.clientRequestId,
      requestHash,
    )
    if (duplicate) {
      if (ownerToken) {
        await this.#registry.releaseOwned(input.sessionId, ownerToken)
      }
      return {
        version: 1,
        outcome: 'deduplicated',
        session: duplicate.session,
        userMessage: duplicate.userMessage,
        ...(this.#manager.activeRunSnapshot(input.sessionId)
          ? { runtime: this.#manager.activeRunSnapshot(input.sessionId) }
          : {}),
      }
    }

    if (input.kind === 'new_session') {
      if (!ownerToken) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'New Session lifecycle was not reserved',
        )
      }
      return this.#startNew(input, requestHash, ownerToken)
    }
    return this.#startExisting(input)
  }

  async #startNew(
    input: Extract<DurableRunStartPayload, { kind: 'new_session' }>,
    requestHash: string,
    ownerToken: string,
  ): Promise<DurableRunStartResult> {
    await this.#assertCandidateAvailable(input.sessionId)
    const project = await this.#projects.get(input.projectId)
    const timestamp = new Date().toISOString()
    const seed: SessionRecord = {
      schemaVersion: 1,
      id: input.sessionId,
      projectId: input.projectId,
      title: input.title?.trim() || defaultTitle(input.message),
      titleSource: 'auto',
      lifecycle: 'active',
      permissionMode: input.permissionMode,
      modelSelection: structuredClone(input.modelSelection),
      goal: input.goal ? structuredClone(input.goal) : null,
      plan: input.plan ? structuredClone(input.plan) : null,
      revision: 1,
      lastSeq: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      await this.#manager.createSession({
        sessionId: input.sessionId,
        workspace: project.path,
        mode: input.permissionMode,
        provider: input.modelSelection.providerId,
        modelSelection: input.modelSelection,
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
      })
      this.#executionState.registerNew(seed, ownerToken)
      this.#registry.adoptNew(input.sessionId, input.projectId, ownerToken)
      return await this.#startLoaded(input)
    } catch (error) {
      const duplicate = await this.#sessions.lookupRequest(
        input.sessionId,
        input.clientRequestId,
        requestHash,
      )
      if (duplicate) {
        await this.#registry.releaseOwned(input.sessionId, ownerToken)
        return {
          version: 1,
          outcome: 'deduplicated',
          session: duplicate.session,
          userMessage: duplicate.userMessage,
        }
      }
      await this.#registry.releaseOwned(input.sessionId, ownerToken)
      throw error
    }
  }

  async #startExisting(
    input: Extract<DurableRunStartPayload, { kind: 'existing_session' }>,
  ): Promise<DurableRunStartResult> {
    const current = await this.#sessions.getRecord(input.sessionId)
    if (current.lifecycle !== 'active') {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Archived Session cannot start a Run',
      )
    }
    await this.#registry.ensureLoaded(input.sessionId)
    const record = this.#executionState.record(input.sessionId)
    if (!record) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding was not loaded',
      )
    }
    return this.#startLoaded(input)
  }

  async #startLoaded(
    input: DurableRunStartPayload,
  ): Promise<DurableRunStartResult> {
    const commitPromise = this.#executionState.beginRequest(
      input.sessionId,
      input.clientRequestId,
    )
    let runId: RunId
    try {
      runId = this.#manager.startRun({
        sessionId: input.sessionId,
        message: input.message,
        clientRequestId: input.clientRequestId,
        ...(input.context ? { context: input.context } : {}),
      })
    } catch (error) {
      this.#executionState.failRequest(
        input.sessionId,
        input.clientRequestId,
        error,
      )
      throw error
    }

    let command: Awaited<typeof commitPromise>
    try {
      command = await Promise.race([
        commitPromise,
        this.#manager
          .waitForRunSettled(input.sessionId, runId)
          .then<never>(() => {
            throw new ApplicationError(
              'PRECONDITION_FAILED',
              'Run ended before its user message was committed',
            )
          }),
      ])
    } catch (error) {
      this.#executionState.failRequest(
        input.sessionId,
        input.clientRequestId,
        error,
      )
      throw error
    }
    const runtime =
      this.#manager.activeRunSnapshot(input.sessionId) ??
      emptyRuntimeSnapshot(input.sessionId, runId)
    return {
      version: 1,
      outcome: 'started',
      commit: command.commit as SessionCommitEnvelope,
      runId,
      runtime,
    }
  }

  async #assertCandidateAvailable(sessionId: SessionId): Promise<void> {
    try {
      await this.#sessions.getRecord(sessionId)
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'NOT_FOUND') {
        return
      }
      throw error
    }
    throw new ApplicationError(
      'CONFLICT',
      'Candidate Session id already exists',
    )
  }
}

function defaultTitle(message: string): string {
  const title = message.trim().replace(/\s+/gu, ' ').slice(0, 256)
  return title || 'New conversation'
}

function emptyRuntimeSnapshot(
  sessionId: SessionId,
  runId: RunId,
): ActiveRunPublicSnapshot {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    status: 'idle',
    text: '',
    reasoning: '',
    tools: [],
    interjections: [],
  }
}
