import type { SessionId, TerminalId } from '../../shared/ids'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import { TerminalPool, type TerminalEventDraft } from '../terminal/pool'
import type { SessionState } from './session-types'

/** Controls session terminal lifecycle and operations. */
export class SessionTerminalController {
  readonly pool: TerminalPool
  readonly #requireSession: (sessionId: SessionId) => SessionState

  constructor(options: {
    getScrollbackBytes: () => number
    emit: (event: TerminalEventDraft) => void
    requireSession: (sessionId: SessionId) => SessionState
  }) {
    this.#requireSession = options.requireSession
    this.pool = new TerminalPool({
      getScrollbackBytes: options.getScrollbackBytes,
      emit: options.emit,
    })
  }

  /** Opens the requested resource. */
  async open(input: {
    sessionId: SessionId
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const session = this.#requireSession(input.sessionId)
    return this.pool.open({
      sessionId: session.sessionId,
      workspace: session.workspace,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
    })
  }

  /** Lists the currently available records. */
  list(sessionId: SessionId): TerminalInfo[] {
    this.#requireSession(sessionId)
    return this.pool.list(sessionId)
  }

  /** Writes the supplied data. */
  write(sessionId: SessionId, terminalId: TerminalId, data: string): boolean {
    this.#requireSession(sessionId)
    return this.pool.write(sessionId, terminalId, data)
  }

  /** Returns or updates resize state. */
  resize(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    this.#requireSession(sessionId)
    return this.pool.resize(sessionId, terminalId, cols, rows)
  }

  /** Closes the resource and releases its handles. */
  close(sessionId: SessionId, terminalId: TerminalId): boolean {
    this.#requireSession(sessionId)
    return this.pool.close(sessionId, terminalId)
  }

  /** Closes session. */
  closeSession(sessionId: SessionId): void {
    this.pool.closeSession(sessionId)
  }

  /** Returns a snapshot of the current state. */
  snapshot(sessionId: SessionId, terminalId: TerminalId): TerminalSnapshot {
    this.#requireSession(sessionId)
    return this.pool.snapshot(sessionId, terminalId)
  }

  /** Releases all owned resources. */
  async dispose(): Promise<void> {
    await this.pool.dispose()
  }
}
