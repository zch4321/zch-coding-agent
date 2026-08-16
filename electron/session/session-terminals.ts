import type { SessionId, TerminalId } from '../../shared/ids'
import type { CommandShellSelection } from '../../shared/command-shell'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import { TerminalPool, type TerminalEventDraft } from '../terminal/pool'
import type { SessionState } from './session-types'

/** Mediates Session-owned terminal lifecycle and I/O through TerminalPool. */
export class SessionTerminalController {
  readonly pool: TerminalPool
  readonly #requireSession: (sessionId: SessionId) => SessionState

  constructor(options: {
    getScrollbackBytes: () => number
    getCommandShellSelection: () => CommandShellSelection
    emit: (event: TerminalEventDraft) => void
    requireSession: (sessionId: SessionId) => SessionState
  }) {
    this.#requireSession = options.requireSession
    this.pool = new TerminalPool({
      getScrollbackBytes: options.getScrollbackBytes,
      getCommandShellSelection: options.getCommandShellSelection,
      emit: options.emit,
    })
  }

  /** Opens a terminal after verifying that its Session exists. */
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

  /** Lists terminals after verifying that the Session exists. */
  list(sessionId: SessionId): TerminalInfo[] {
    this.#requireSession(sessionId)
    return this.pool.list(sessionId)
  }

  /** Writes input to a Session-owned terminal after ownership validation. */
  write(sessionId: SessionId, terminalId: TerminalId, data: string): boolean {
    this.#requireSession(sessionId)
    return this.pool.write(sessionId, terminalId, data)
  }

  /** Resizes a Session-owned terminal after validating its dimensions. */
  resize(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    this.#requireSession(sessionId)
    return this.pool.resize(sessionId, terminalId, cols, rows)
  }

  /** Closes one Session-owned terminal. */
  close(sessionId: SessionId, terminalId: TerminalId): boolean {
    this.#requireSession(sessionId)
    return this.pool.close(sessionId, terminalId)
  }

  /** Closes every terminal owned by a Session. */
  closeSession(sessionId: SessionId): void {
    this.pool.closeSession(sessionId)
  }

  /** Returns a Session-owned terminal's process and scrollback snapshot. */
  snapshot(sessionId: SessionId, terminalId: TerminalId): TerminalSnapshot {
    this.#requireSession(sessionId)
    return this.pool.snapshot(sessionId, terminalId)
  }

  /** Disposes the underlying TerminalPool and waits for terminal cleanup. */
  async dispose(): Promise<void> {
    await this.pool.dispose()
  }
}
