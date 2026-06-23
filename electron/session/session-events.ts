import type { TerminalEvent } from '../../shared/agent-events'
import { IPC_VERSION } from '../../shared/channels'
import type { SessionId } from '../../shared/ids'
import { sendAgentEvent, sendTerminalEvent } from '../ipc/event-sink'
import type { TerminalEventDraft } from '../terminal/pool'
import type {
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
  TerminalEventDraftEnvelope,
} from './session-types'

export class SessionEventEmitter {
  readonly #getWebContents: SessionManagerOptions['getWebContents']
  readonly #getSession: (sessionId: SessionId) => SessionState | undefined

  constructor(options: {
    getWebContents: SessionManagerOptions['getWebContents']
    getSession: (sessionId: SessionId) => SessionState | undefined
  }) {
    this.#getWebContents = options.getWebContents
    this.#getSession = options.getSession
  }

  emitAgent(session: SessionState, event: AgentEventDraft): void {
    if (session.closed && event.type !== 'session.closed') {
      return
    }

    const webContents = this.#getWebContents()

    if (!webContents) {
      return
    }

    sendAgentEvent(webContents, {
      version: IPC_VERSION,
      event: {
        schemaVersion: 1,
        seq: (session.eventSeq += 1),
        ts: new Date().toISOString(),
        ...event,
      } as Parameters<typeof sendAgentEvent>[1]['event'],
    })
  }

  emitTerminal(event: TerminalEventDraft): void {
    const session = this.#getSession(event.sessionId)
    const webContents = this.#getWebContents()

    if (!session || !webContents) {
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

    sendTerminalEvent(webContents, {
      version: IPC_VERSION,
      event: {
        schemaVersion: 1,
        seq: event.seq,
        ts: new Date().toISOString(),
        ...draft,
      } as TerminalEvent,
    })
  }
}
