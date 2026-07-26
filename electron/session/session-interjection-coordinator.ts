import type { ConfigStore } from '../config/store'
import type { MessageId } from '../../shared/ids'
import { appendPromptLayer } from './prompt-harness'
import type {
  ActiveRun,
  AgentEventDraft,
  RunInterjection,
  SessionState,
} from './session-types'

/** Captures a drained batch so an unsuccessful durable commit can be undone. */
export interface DrainedInterjectionBatch {
  interjections: RunInterjection[]
  appendedMessageIds: MessageId[]
  previousNextMessageSeq: number
}

/** Queues live user interjections and emits their queued, superseded, and carryover states. */
export class SessionInterjectionCoordinator {
  readonly #configStore: ConfigStore
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void

  constructor(options: {
    configStore: ConfigStore
    emit: (session: SessionState, event: AgentEventDraft) => void
  }) {
    this.#configStore = options.configStore
    this.#emit = options.emit
  }

  /** Adds an interjection to the active run queue with a stable request identity. */
  queue(
    session: SessionState,
    run: ActiveRun,
    input: {
      message: string
      clientRequestId: string
    },
  ): boolean {
    // Idempotent: a repeated clientRequestId is a no-op across the full
    // interjection lifecycle (queued, injected, superseded, carried over), so
    // retried IPC cannot re-queue an already-handled interjection.
    if (run.processedInterjectionIds.has(input.clientRequestId)) {
      return true
    }

    const interjection: RunInterjection = {
      id: input.clientRequestId,
      clientRequestId: input.clientRequestId,
      runId: run.runId,
      content: input.message,
      createdAt: new Date().toISOString(),
      status: 'queued',
    }
    run.pendingInterjections.push(interjection)
    run.processedInterjectionIds.add(input.clientRequestId)
    this.#emitInterjectionEvent(session, interjection)
    void this.#logInterjection(session, interjection)
    return true
  }

  /** Appends all queued interjections and returns the state needed for rollback. */
  async drain(
    session: SessionState,
    run: ActiveRun,
  ): Promise<DrainedInterjectionBatch | undefined> {
    const pending = run.pendingInterjections
    if (pending.length === 0) return undefined

    const batchId = run.lastToolBatchId
    const config = this.#configStore.getPublicConfig()
    const toInject = pending.splice(0, pending.length)
    const batch: DrainedInterjectionBatch = {
      interjections: toInject,
      appendedMessageIds: [],
      previousNextMessageSeq: session.nextMessageSeq,
    }

    try {
      // Multiple queued interjections are flushed in arrival order. Each one is
      // injected as its own pinned prompt layer and persisted/traced separately,
      // even though they all flow into the same model continuation.
      for (const interjection of toInject) {
        const record = appendPromptLayer(session, {
          kind: 'interjection',
          content: interjection.content,
          source: 'run.interjection',
          trusted: false,
          editable: false,
          config,
          turnId: run.rootUserMessageId,
          interjectionId: interjection.id,
        })
        batch.appendedMessageIds.push(record.id)
        interjection.status = 'injected'
        if (batchId) {
          interjection.injectedAfterToolBatchId = batchId
        }
        this.#emitInterjectionEvent(session, interjection)
        await this.#logInterjection(session, interjection)
      }
      return batch
    } catch (error) {
      this.restore(session, run, batch)
      throw error
    }
  }

  /** Restores a drained batch after its durable commit fails. */
  restore(
    session: SessionState,
    run: ActiveRun,
    batch: DrainedInterjectionBatch,
  ): void {
    const appended = new Set(batch.appendedMessageIds)
    session.history = session.history.filter(
      (record) => !appended.has(record.id),
    )
    session.nextMessageSeq = batch.previousNextMessageSeq
    for (const interjection of batch.interjections) {
      interjection.status = 'queued'
      delete interjection.injectedAfterToolBatchId
      this.#emitInterjectionEvent(session, interjection)
      void this.#logInterjection(session, interjection).catch(() => undefined)
    }
    run.pendingInterjections = [
      ...batch.interjections,
      ...run.pendingInterjections,
    ]
  }

  /** Marks queued interjections superseded and emits the corresponding state changes. */
  supersedePending(session: SessionState, run: ActiveRun): void {
    for (const interjection of run.pendingInterjections) {
      if (interjection.status === 'queued') {
        interjection.status = 'superseded'
        this.#emitInterjectionEvent(session, interjection)
        void this.#logInterjection(session, interjection)
      }
    }
    run.pendingInterjections = []
  }

  /** Moves pending interjections to the next ordinary turn and emits carryover signals. */
  async carryOver(session: SessionState, run: ActiveRun): Promise<void> {
    // Final-answer branch: pending interjections become the next ordinary
    // user turn. Emit a carryover signal (and trace) for each, then drop them
    // from this run so the renderer can start a fresh run with the content.
    const toCarry = run.pendingInterjections.splice(
      0,
      run.pendingInterjections.length,
    )
    for (const interjection of toCarry) {
      this.#emit(session, {
        type: 'interjection.carryover',
        sessionId: session.sessionId,
        runId: run.runId,
        interjectionId: interjection.id,
        content: interjection.content,
        createdAt: interjection.createdAt,
      })
      await session.logger.write({
        type: 'interjection.message',
        sessionId: session.sessionId,
        runId: run.runId,
        interjectionId: interjection.id,
        status: 'carryover',
        content: interjection.content,
        createdAt: interjection.createdAt,
      })
    }
  }

  #emitInterjectionEvent(
    session: SessionState,
    interjection: RunInterjection,
  ): void {
    this.#emit(session, {
      type: 'interjection.updated',
      sessionId: session.sessionId,
      runId: interjection.runId,
      interjectionId: interjection.id,
      status: interjection.status,
      content: interjection.content,
      createdAt: interjection.createdAt,
      ...(interjection.injectedAfterToolBatchId
        ? {
            injectedAfterToolBatchId: interjection.injectedAfterToolBatchId,
          }
        : {}),
    })
  }

  async #logInterjection(
    session: SessionState,
    interjection: RunInterjection,
  ): Promise<void> {
    await session.logger.write({
      type: 'interjection.message',
      sessionId: session.sessionId,
      runId: interjection.runId,
      interjectionId: interjection.id,
      status: interjection.status,
      content: interjection.content,
      createdAt: interjection.createdAt,
      ...(interjection.injectedAfterToolBatchId
        ? {
            injectedAfterToolBatchId: interjection.injectedAfterToolBatchId,
          }
        : {}),
    })
  }
}
