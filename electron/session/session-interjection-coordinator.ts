import type { ConfigStore } from '../config/store'
import { appendPromptLayer } from './prompt-harness'
import type {
  ActiveRun,
  AgentEventDraft,
  RunInterjection,
  SessionState,
} from './session-types'

const INTERJECTION_RULE_NOTE =
  'Messages tagged as <live_user_interjection> are real user messages received while the current run was already in progress. They are not tool output. Treat them as the latest user instruction for the next reasoning step, while respecting system, developer, runtime, repository, and tool-safety instructions.'

function liveUserInterjectionContent(content: string): string {
  return [
    '<live_user_interjection>',
    content,
    '</live_user_interjection>',
    '',
    INTERJECTION_RULE_NOTE,
  ].join('\n')
}

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
      conversationId: session.conversationId,
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

  async drain(session: SessionState, run: ActiveRun): Promise<void> {
    const pending = run.pendingInterjections
    if (pending.length === 0) return

    const batchId = run.lastToolBatchId
    const config = this.#configStore.getPublicConfig()
    const toInject = pending.splice(0, pending.length)

    // Multiple queued interjections are flushed in arrival order. Each one is
    // injected as its own pinned prompt layer and persisted/traced separately,
    // even though they all flow into the same model continuation.
    for (const interjection of toInject) {
      appendPromptLayer(session, {
        kind: 'user_interjection',
        role: 'user',
        content: liveUserInterjectionContent(interjection.content),
        source: 'run.interjection',
        trusted: false,
        editable: false,
        config,
      })
      interjection.status = 'injected'
      if (batchId) {
        interjection.injectedAfterToolBatchId = batchId
      }
      this.#emitInterjectionEvent(session, interjection)
      await this.#logInterjection(session, interjection)
    }
  }

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
