import type { SessionId } from '../../shared/ids'

/** Tracks natural completion eligibility only for this process; claims are never replayed. */
export class BackgroundWakeupGate {
  readonly #epochs = new Map<SessionId, object>()
  readonly #eligible = new Map<SessionId, object>()

  /** Invalidates old completion and claims at each new Run, user intent, or lifecycle mutation. */
  invalidate(sessionId: SessionId): object {
    const epoch = {}
    this.#epochs.set(sessionId, epoch)
    this.#eligible.delete(sessionId)
    return epoch
  }

  /** Offers one claim only after the same naturally completed Run has fully settled. */
  settled(sessionId: SessionId, epoch: object, natural: boolean): void {
    if (natural && this.#epochs.get(sessionId) === epoch)
      this.#eligible.set(sessionId, epoch)
  }

  /** Consumes eligibility at event occurrence, without remembering events that arrive while busy. */
  claim(sessionId: SessionId): object | undefined {
    const epoch = this.#eligible.get(sessionId)
    this.#eligible.delete(sessionId)
    return epoch
  }

  /** Checks that no user intent or newer Run invalidated an in-flight notification preparation. */
  valid(sessionId: SessionId, epoch: object): boolean {
    return this.#epochs.get(sessionId) === epoch
  }

  /** Forgets an evicted Session so loading history cannot recreate eligibility. */
  forget(sessionId: SessionId): void {
    this.#epochs.delete(sessionId)
    this.#eligible.delete(sessionId)
  }
}
