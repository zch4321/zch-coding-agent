import type { SessionCommandResult } from '../../shared/domain-state-api'
import type { RunId, SessionId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import type {
  SessionExecutionCommit,
  SessionExecutionStatePort,
  SessionState,
} from '../session/session-types'
import { ApplicationError } from './application-error'
import { SessionService } from './session-service'

interface CommitWaiter {
  promise: Promise<SessionCommandResult>
  resolve: (result: SessionCommandResult) => void
  reject: (error: unknown) => void
}

interface DurableSessionBinding {
  record: SessionRecord
  isNew: boolean
  ownerToken: string
  waiters: Map<string, CommitWaiter>
  commitTail: Promise<void>
  invalid: boolean
}

/** Bridges in-memory session execution state to durable records and serialized commits. */
export class DurableExecutionStatePort implements SessionExecutionStatePort {
  readonly #sessions: SessionService
  readonly #bindings = new Map<SessionId, DurableSessionBinding>()
  #onInvalid: (sessionId: SessionId, runId?: RunId) => void = () => undefined

  constructor(sessions: SessionService) {
    this.#sessions = sessions
  }

  /** Installs the callback used when a durable binding can no longer be trusted. */
  setInvalidationHandler(
    handler: (sessionId: SessionId, runId?: RunId) => void,
  ): void {
    this.#onInvalid = handler
  }

  /** Creates an owned binding for a new session and enforces its initial revision invariants. */
  registerNew(record: SessionRecord, ownerToken: string): void {
    if (record.lastSeq !== 0 || record.revision !== 1) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'New durable binding must start at revision 1 with no messages',
      )
    }
    this.#register(record, true, ownerToken)
  }

  /** Attaches an owner token to an existing durable session record. */
  registerExisting(record: SessionRecord, ownerToken: string): void {
    this.#register(record, false, ownerToken)
  }

  /** Replaces a binding's durable record after validating ownership and binding state. */
  applyRecord(
    sessionId: SessionId,
    record: SessionRecord,
    ownerToken: string,
  ): void {
    const binding = this.#requireOwner(sessionId, ownerToken)
    if (binding.invalid) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding is invalid',
      )
    }
    binding.record = structuredClone(record)
    binding.isNew = false
  }

  /** Creates or reuses the promise tracking one idempotent client request. */
  beginRequest(
    sessionId: SessionId,
    clientRequestId: string,
  ): Promise<SessionCommandResult> {
    const binding = this.#requireBinding(sessionId)
    if (binding.invalid) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding is invalid',
      )
    }
    const existing = binding.waiters.get(clientRequestId)
    if (existing) return existing.promise
    let resolve!: (result: SessionCommandResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<SessionCommandResult>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    binding.waiters.set(clientRequestId, { promise, resolve, reject })
    return promise
  }

  /** Rejects and removes the waiter for a client request that failed before commit. */
  failRequest(
    sessionId: SessionId,
    clientRequestId: string,
    error: unknown,
  ): void {
    const binding = this.#bindings.get(sessionId)
    const waiter = binding?.waiters.get(clientRequestId)
    if (!binding || !waiter) return
    binding.waiters.delete(clientRequestId)
    waiter.reject(error)
  }

  /** Removes an owned binding and rejects requests still waiting on its commits. */
  forget(sessionId: SessionId, ownerToken: string): void {
    const binding = this.#bindings.get(sessionId)
    if (!binding || binding.ownerToken !== ownerToken) return
    this.#bindings.delete(sessionId)
    const error = new ApplicationError(
      'PRECONDITION_FAILED',
      'Live Session context was evicted',
    )
    for (const waiter of binding.waiters.values()) waiter.reject(error)
    binding.waiters.clear()
  }

  /** Serializes a session commit and reconciles the in-memory state after success or failure. */
  commit(
    session: SessionState,
    input: SessionExecutionCommit,
  ): Promise<SessionCommandResult | undefined> {
    const binding = this.#requireBinding(session.sessionId)
    if (binding.invalid) {
      return Promise.reject(
        new ApplicationError(
          'PRECONDITION_FAILED',
          'Durable Session binding is invalid',
        ),
      )
    }
    const ownerToken = binding.ownerToken
    const execute = () => this.#commitOwned(session, input, ownerToken, binding)
    const result = binding.commitTail.then(execute, execute)
    binding.commitTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Returns a cloned durable record when the session has a valid binding. */
  record(sessionId: SessionId): SessionRecord | undefined {
    const binding = this.#bindings.get(sessionId)
    if (!binding || binding.invalid) return undefined
    return structuredClone(binding.record)
  }

  async #commitOwned(
    session: SessionState,
    input: SessionExecutionCommit,
    ownerToken: string,
    queuedBinding: DurableSessionBinding,
  ): Promise<SessionCommandResult | undefined> {
    const binding = this.#requireOwner(session.sessionId, ownerToken)
    if (binding !== queuedBinding || binding.invalid) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding changed before commit',
      )
    }
    const records = session.history
      .filter((record) => record.seq > binding.record.lastSeq)
      .sort((left, right) => left.seq - right.seq)

    try {
      if (binding.isNew) {
        const finalRecord: SessionRecord = {
          ...binding.record,
          permissionMode: session.mode,
          modelSelection: structuredClone(session.modelSelection),
          goal: session.goal ? structuredClone(session.goal) : null,
          plan: session.plan ? structuredClone(session.plan) : null,
          lastSeq: records.at(-1)?.seq ?? 0,
          updatedAt: new Date().toISOString(),
        }
        const requestHash = originalRequestHash(records)
        const committed = await this.#sessions.commitFirstTurn({
          session: finalRecord,
          messages: records,
          requestHash,
        })
        if (committed.outcome === 'deduplicated') {
          throw new ApplicationError(
            'CONFLICT',
            'First-turn request was committed by another runtime',
          )
        }
        binding.record = structuredClone(committed.result.commit.change.session)
        binding.isNew = false
        this.#resolveCommittedRequests(binding, records, committed.result)
        return committed.result
      }

      const metadataChanged =
        session.mode !== binding.record.permissionMode ||
        JSON.stringify(session.modelSelection) !==
          JSON.stringify(binding.record.modelSelection) ||
        JSON.stringify(session.goal ?? null) !==
          JSON.stringify(binding.record.goal) ||
        JSON.stringify(session.plan ?? null) !==
          JSON.stringify(binding.record.plan)
      if (
        records.length === 0 &&
        !metadataChanged &&
        input.deactivateThroughSeq === undefined
      ) {
        return undefined
      }

      const result = await this.#sessions.commitMutation({
        sessionId: session.sessionId,
        expectedRevision: binding.record.revision,
        expectedLastSeq: binding.record.lastSeq,
        messages: records,
        metadata: {
          permissionMode: session.mode,
          modelSelection: structuredClone(session.modelSelection),
          goal: session.goal ? structuredClone(session.goal) : null,
          plan: session.plan ? structuredClone(session.plan) : null,
        },
        ...(input.deactivateThroughSeq === undefined
          ? {}
          : { deactivateThroughSeq: input.deactivateThroughSeq }),
        messageChange: input.invalidate ? 'invalidate' : undefined,
      })
      binding.record = structuredClone(result.commit.change.session)
      this.#resolveCommittedRequests(binding, records, result)
      return result
    } catch (error) {
      await this.#recoverAfterFailure(session, binding, records, error)
      if (input.reason === 'tool_batch' && !binding.invalid) {
        binding.invalid = true
        this.#onInvalid(session.sessionId, session.activeRun?.runId)
      }
      throw error
    }
  }

  async #recoverAfterFailure(
    session: SessionState,
    binding: DurableSessionBinding,
    attemptedRecords: readonly SessionState['history'][number][],
    commitError: unknown,
  ): Promise<void> {
    const attemptedRequestIds = attemptedRecords.flatMap((record) =>
      record.kind === 'user_input' && 'clientRequestId' in record
        ? [record.clientRequestId]
        : [],
    )
    try {
      const durable = await this.#sessions.loadRuntimeState(
        session.sessionId,
        attemptedRequestIds,
      )
      const committedRequestIds = new Set(durable.committedClientRequestIds)
      session.history = structuredClone(durable.activeHistory)
      session.nextMessageSeq = durable.record.lastSeq + 1
      session.mode = durable.record.permissionMode
      session.provider = durable.record.modelSelection.providerId
      session.modelSelection = structuredClone(durable.record.modelSelection)
      session.modelSelectionPinned = true
      session.goal = durable.record.goal
        ? structuredClone(durable.record.goal)
        : undefined
      session.plan = durable.record.plan
        ? structuredClone(durable.record.plan)
        : undefined
      binding.record = structuredClone(durable.record)
      binding.isNew = false
      for (const clientRequestId of attemptedRequestIds) {
        if (committedRequestIds.has(clientRequestId)) continue
        session.clientRequests.delete(clientRequestId)
        const waiter = binding.waiters.get(clientRequestId)
        if (waiter) {
          binding.waiters.delete(clientRequestId)
          waiter.reject(commitError)
        }
      }
    } catch {
      if (binding.isNew) {
        session.history = []
        session.nextMessageSeq = 1
        for (const clientRequestId of attemptedRequestIds) {
          session.clientRequests.delete(clientRequestId)
          const waiter = binding.waiters.get(clientRequestId)
          if (waiter) {
            binding.waiters.delete(clientRequestId)
            waiter.reject(commitError)
          }
        }
        return
      }
      binding.invalid = true
      for (const waiter of binding.waiters.values()) waiter.reject(commitError)
      binding.waiters.clear()
      this.#onInvalid(session.sessionId, session.activeRun?.runId)
    }
  }

  #resolveCommittedRequests(
    binding: DurableSessionBinding,
    records: readonly SessionState['history'][number][],
    result: SessionCommandResult,
  ): void {
    for (const record of records) {
      if (record.kind !== 'user_input' || !('clientRequestId' in record)) {
        continue
      }
      const waiter = binding.waiters.get(record.clientRequestId)
      if (!waiter) continue
      binding.waiters.delete(record.clientRequestId)
      waiter.resolve(result)
    }
  }

  #register(record: SessionRecord, isNew: boolean, ownerToken: string): void {
    const existing = this.#bindings.get(record.id)
    if (existing && existing.ownerToken !== ownerToken) {
      throw new ApplicationError(
        'CONFLICT',
        'Durable Session binding has another owner',
      )
    }
    this.#bindings.set(record.id, {
      record: structuredClone(record),
      isNew,
      ownerToken,
      waiters: existing?.waiters ?? new Map(),
      commitTail: existing?.commitTail ?? Promise.resolve(),
      invalid: false,
    })
  }

  #requireOwner(
    sessionId: SessionId,
    ownerToken: string,
  ): DurableSessionBinding {
    const binding = this.#requireBinding(sessionId)
    if (binding.ownerToken !== ownerToken) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Durable Session binding ownership changed',
      )
    }
    return binding
  }

  #requireBinding(sessionId: SessionId): DurableSessionBinding {
    const binding = this.#bindings.get(sessionId)
    if (!binding) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Session has no durable execution-state binding',
      )
    }
    return binding
  }
}

function originalRequestHash(
  records: readonly SessionState['history'][number][],
): string {
  const user = records.find(
    (record) => record.kind === 'user_input' && 'clientRequestId' in record,
  )
  if (
    user?.kind !== 'user_input' ||
    !('clientRequestId' in user) ||
    !user.metadata?.requestHash
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'First-turn user message is missing its request hash',
    )
  }
  return user.metadata.requestHash
}
