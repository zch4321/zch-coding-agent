import type { TerminalEvent } from '../../shared/agent-events'
import type { SessionId } from '../../shared/ids'
import type { TerminalEventDraft } from '../terminal/pool'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type {
  AgentEventDraft,
  SessionState,
  TerminalEventDraftEnvelope,
} from './session-types'

/** Emits Session agent and terminal events through RuntimeEventSink with lifecycle checks. */
export class SessionEventEmitter {
  readonly #eventSink: RuntimeEventSink
  readonly #getSession: (sessionId: SessionId) => SessionState | undefined

  constructor(options: {
    eventSink: RuntimeEventSink
    getSession: (sessionId: SessionId) => SessionState | undefined
  }) {
    this.#eventSink = options.eventSink
    this.#getSession = options.getSession
  }

  /** Emits a session-scoped agent event while enforcing closed-session event rules. */
  emitAgent(session: SessionState, event: AgentEventDraft): void {
    if (session.visibility === 'internal') return
    if (
      session.closed &&
      event.type !== 'session.closed' &&
      event.type !== 'workspace.writer.changed'
    ) {
      return
    }

    this.#eventSink.publishAgent({
      schemaVersion: 1,
      seq: (session.eventSeq += 1),
      ts: new Date().toISOString(),
      ...event,
    } as Parameters<RuntimeEventSink['publishAgent']>[0])
  }

  /** Looks up the target Session and emits a terminal event when it is still loaded. */
  emitTerminal(event: TerminalEventDraft): void {
    const session = this.#getSession(event.sessionId)
    if (!session || session.visibility === 'internal') {
      return
    }

    const draft: TerminalEventDraftEnvelope =
      event.type === 'terminal.output'
        ? {
            type: 'terminal.output',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            chunk: event.chunk ?? '',
          }
        : {
            type: 'terminal.status',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            status: event.status ?? 'failed',
            ...(event.exitCode !== undefined
              ? { exitCode: event.exitCode }
              : {}),
          }

    this.#eventSink.publishTerminal({
      schemaVersion: 1,
      seq: event.seq,
      ts: new Date().toISOString(),
      ...draft,
    } as TerminalEvent)
  }
}
