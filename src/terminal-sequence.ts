import type { TerminalEvent } from '../shared/agent-events'
import type { TerminalId } from '../shared/ids'

export type TerminalSequenceDecision = 'apply' | 'ignore' | 'recover' | 'queue'

/** Tracks per-terminal event sequences and bounds replay while a terminal recovers. */
export class TerminalSequenceTracker {
  readonly #last = new Map<TerminalId, number>()
  readonly #recovering = new Set<TerminalId>()
  readonly #queued = new Map<TerminalId, TerminalEvent[]>()

  /** Classifies an event as new, duplicate, queued, or requiring terminal resynchronization. */
  observe(event: TerminalEvent): TerminalSequenceDecision {
    if (this.#recovering.has(event.terminalId)) {
      this.defer(event)
      return 'queue'
    }

    const previous = this.#last.get(event.terminalId) ?? 0

    if (event.seq <= previous) {
      return 'ignore'
    }

    if (previous > 0 && event.seq !== previous + 1) {
      this.startRecovery(event.terminalId)
      this.defer(event)
      return 'recover'
    }

    this.#last.set(event.terminalId, event.seq)
    return 'apply'
  }

  /** Queues a terminal event during recovery while retaining only bounded recent history. */
  defer(event: TerminalEvent): void {
    const queued = this.#queued.get(event.terminalId) ?? []
    queued.push(event)
    this.#queued.set(event.terminalId, queued.slice(-256))
  }

  /** Marks a terminal as recovering so incoming events are deferred until a snapshot arrives. */
  startRecovery(terminalId: TerminalId): void {
    this.#recovering.add(terminalId)
  }

  /** Installs a snapshot sequence and returns queued events eligible for replay. */
  completeRecovery(
    terminalId: TerminalId,
    snapshotSeq: number,
  ): TerminalEvent[] {
    this.#last.set(terminalId, snapshotSeq)
    this.#recovering.delete(terminalId)
    const queued = this.#queued.get(terminalId) ?? []
    this.#queued.delete(terminalId)
    return queued
      .filter((event) => event.seq > snapshotSeq)
      .sort((left, right) => left.seq - right.seq)
  }

  /** Drops recovery state and queued events for a terminal without replaying them. */
  cancelRecovery(terminalId: TerminalId): void {
    this.#recovering.delete(terminalId)
    this.#queued.delete(terminalId)
  }

  /** Clears sequence, recovery, and queued-event state for every terminal. */
  reset(): void {
    this.#last.clear()
    this.#recovering.clear()
    this.#queued.clear()
  }
}
