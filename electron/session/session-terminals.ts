import type { SessionId, TerminalId } from '../../shared/ids'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import { TerminalPool, type TerminalEventDraft } from '../terminal/pool'
import type { SessionState } from './session-types'

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

  list(sessionId: SessionId): TerminalInfo[] {
    this.#requireSession(sessionId)
    return this.pool.list(sessionId)
  }

  write(sessionId: SessionId, terminalId: TerminalId, data: string): boolean {
    this.#requireSession(sessionId)
    return this.pool.write(sessionId, terminalId, data)
  }

  resize(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    this.#requireSession(sessionId)
    return this.pool.resize(sessionId, terminalId, cols, rows)
  }

  close(sessionId: SessionId, terminalId: TerminalId): boolean {
    this.#requireSession(sessionId)
    return this.pool.close(sessionId, terminalId)
  }

  closeSession(sessionId: SessionId): void {
    this.pool.closeSession(sessionId)
  }

  snapshot(sessionId: SessionId, terminalId: TerminalId): TerminalSnapshot {
    this.#requireSession(sessionId)
    return this.pool.snapshot(sessionId, terminalId)
  }

  async dispose(): Promise<void> {
    await this.pool.dispose()
  }
}
