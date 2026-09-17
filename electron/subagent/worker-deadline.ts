import type { RunStatus } from '../../shared/agent-events'

/** Measures one active worker allowance, excluding safe pauses and human approval waits. */
export class WorkerDeadline {
  #timer: ReturnType<typeof setTimeout> | undefined
  #remaining: number
  #startedAt = 0
  #active = false
  #expired = false
  #disposed = false

  constructor(
    private readonly allowance: number,
    private readonly expire: () => void,
  ) {
    this.#remaining = allowance
    this.setActive(true)
  }

  /** Tracks Run phases without charging time spent waiting on a person or resume. */
  phase(status: RunStatus): void {
    this.setActive(
      ![
        'paused',
        'awaiting_approval',
        'completed',
        'cancelled',
        'cancelling',
        'failed',
      ].includes(status),
    )
  }

  /** Grants a new allowance following an explicit resume. */
  reset(): void {
    this.#clear()
    this.#remaining = this.allowance
    this.#expired = false
    this.#active = false
    this.setActive(true)
  }

  /** Starts or suspends elapsed-time accounting. */
  setActive(active: boolean): void {
    if (this.#disposed || this.#expired || active === this.#active) return
    if (this.#active) {
      this.#remaining = Math.max(
        0,
        this.#remaining - (performance.now() - this.#startedAt),
      )
      this.#clear()
    }
    this.#active = active
    if (!active) return
    this.#startedAt = performance.now()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#active = false
      this.#expired = true
      this.expire()
    }, this.#remaining)
  }

  /** Releases the deadline when its worker has settled. */
  dispose(): void {
    this.#disposed = true
    this.#clear()
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
