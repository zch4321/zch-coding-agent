import type {
  DurableRunStartPayload,
  DurableRunStartResult,
  SessionCommitEnvelopeSchema,
} from '../../shared/domain-state-api'
import type { RunId, SessionId } from '../../shared/ids'
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
    const request = this.#start(input).catch((error) => {
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

  evictRequestCacheForSession(sessionId: SessionId): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.#requests.keys()) {
      if (key.startsWith(prefix)) this.#requests.delete(key)
    }
  }

  async #start(input: DurableRunStartPayload): Promise<DurableRunStartResult> {
    if (
      input.kind === 'new_session' &&
      /^\/compact(?:\s|$)/iu.test(input.message.trimStart())
    ) {
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
      return this.#startNew(input, requestHash)
    }
    return this.#startExisting(input)
  }

  async #startNew(
    input: Extract<DurableRunStartPayload, { kind: 'new_session' }>,
    requestHash: string,
  ): Promise<DurableRunStartResult> {
    await this.#assertCandidateAvailable(input.sessionId)
    const project = await this.#projects.get(input.projectId)
    const timestamp = new Date().toISOString()
    const seed: SessionRecord = {
      schemaVersion: 1,
      id: input.sessionId,
      projectId: input.projectId,
      title: input.title?.trim() || defaultTitle(input.message),
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
    let created = false
    try {
      await this.#manager.createSession({
        conversationId: input.sessionId,
        sessionId: input.sessionId,
        workspace: project.path,
        mode: input.permissionMode,
        provider: input.modelSelection.providerId,
        modelSelection: input.modelSelection,
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
      })
      created = true
      this.#registry.adoptNew(input.sessionId, input.projectId)
      this.#executionState.registerNew(seed)
      return await this.#startLoaded(input)
    } catch (error) {
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
        }
      }
      if (created) await this.#manager.closeSession(input.sessionId)
      this.#executionState.forget(input.sessionId)
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
