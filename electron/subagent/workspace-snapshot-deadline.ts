import { WorkspaceSnapshotError } from './workspace-snapshot-types'

const SNAPSHOT_TIMEOUT_MS = 60_000

/** Combines parent cancellation with the fixed workspace snapshot deadline. */
export class SnapshotDeadline {
  readonly #expiresAt: number
  readonly #signal: AbortSignal

  constructor(signal: AbortSignal) {
    this.#expiresAt = performance.now() + SNAPSHOT_TIMEOUT_MS
    this.#signal = signal
  }

  /** Throws the stable snapshot error for cancellation or elapsed deadline. */
  check(): void {
    if (this.#signal.aborted) throw this.#signal.reason
    if (performance.now() >= this.#expiresAt) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_TIMEOUT',
        'Workspace snapshot exceeded 60 seconds',
      )
    }
  }

  /** Returns the remaining command budget after checking cancellation. */
  remainingMs(): number {
    this.check()
    return Math.max(1, Math.ceil(this.#expiresAt - performance.now()))
  }

  /** Exposes the parent cancellation signal to streaming filesystem work. */
  get signal(): AbortSignal {
    return this.#signal
  }
}
