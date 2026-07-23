import type { SessionCommandResult } from '../../shared/domain-state-api'
import type { SessionId } from '../../shared/ids'
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
  waiters: Map<string, CommitWaiter>
}

export class DurableExecutionStatePort implements SessionExecutionStatePort {
  readonly #sessions: SessionService
  readonly #bindings = new Map<SessionId, DurableSessionBinding>()

  constructor(sessions: SessionService) {
    this.#sessions = sessions
  }

  registerNew(record: SessionRecord): void {
    if (record.lastSeq !== 0 || record.revision !== 1) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'New durable binding must start at revision 1 with no messages',
      )
    }
    this.#bindings.set(record.id, {
      record: structuredClone(record),
      isNew: true,
      waiters: new Map(),
    })
  }

  registerExisting(record: SessionRecord): void {
    this.#bindings.set(record.id, {
      record: structuredClone(record),
      isNew: false,
      waiters: new Map(),
    })
  }

  beginRequest(
    sessionId: SessionId,
    clientRequestId: string,
  ): Promise<SessionCommandResult> {
    const binding = this.#requireBinding(sessionId)
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

  failRequest(
    sessionId: SessionId,
    clientRequestId: string,
    error: unknown,
  ): void {
    const waiter = this.#bindings.get(sessionId)?.waiters.get(clientRequestId)
    if (!waiter) return
    this.#bindings.get(sessionId)?.waiters.delete(clientRequestId)
    waiter.reject(error)
  }

  forget(sessionId: SessionId): void {
    const binding = this.#bindings.get(sessionId)
    if (!binding) return
    this.#bindings.delete(sessionId)
    const error = new ApplicationError(
      'PRECONDITION_FAILED',
      'Live Session context was evicted',
    )
    for (const waiter of binding.waiters.values()) waiter.reject(error)
    binding.waiters.clear()
  }

  async commit(
    session: SessionState,
    input: SessionExecutionCommit,
  ): Promise<SessionCommandResult | undefined> {
    const binding = this.#requireBinding(session.sessionId)
    const records = session.history
      .filter((record) => record.seq > binding.record.lastSeq)
      .sort((left, right) => left.seq - right.seq)

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
  }

  record(sessionId: SessionId): SessionRecord | undefined {
    const record = this.#bindings.get(sessionId)?.record
    return record ? structuredClone(record) : undefined
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
