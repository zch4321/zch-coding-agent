export type RunPauseReason = 'timeout' | 'requested'

/** Parks a live Run at a completed history boundary without aborting its resources. */
export class RunPauseControl {
  #requested = false
  #paused = false
  #reason: RunPauseReason | undefined
  #wake: (() => void) | undefined

  constructor(private readonly changed: () => void) {}

  /** Reports a pending safe pause request. */
  get requested(): boolean {
    return this.#requested
  }

  /** Reports that the Run is parked and owns no model execution slot. */
  get paused(): boolean {
    return this.#paused
  }

  /** Returns the cause of the current pause request. */
  get reason(): RunPauseReason | undefined {
    return this.#reason
  }

  /** Requests a pause after the current response and complete tool batch. */
  request(reason: RunPauseReason): boolean {
    if (this.#requested) return false
    this.#requested = true
    this.#reason = reason
    this.changed()
    return true
  }

  /** Resumes the same Run or withdraws a pause which has not reached its boundary. */
  resume(): boolean {
    if (!this.#requested) return false
    this.#requested = false
    this.#reason = undefined
    this.#wake?.()
    this.changed()
    return true
  }

  /** Waits only at an explicit safe boundary, preserving normal cancellation. */
  async checkpoint(
    signal: AbortSignal,
    settle: () => Promise<unknown>,
  ): Promise<void> {
    signal.throwIfAborted()
    if (!this.#requested) return
    await settle()
    signal.throwIfAborted()
    while (this.#requested) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort)
          this.#wake = undefined
          resolve()
        }
        const abort = () => {
          signal.removeEventListener('abort', abort)
          this.#wake = undefined
          reject(signal.reason)
        }
        this.#wake = finish
        signal.addEventListener('abort', abort, { once: true })
        this.#paused = true
        this.changed()
        if (signal.aborted) abort()
      }).finally(() => {
        this.#paused = false
        this.changed()
      })
      signal.throwIfAborted()
    }
  }
}
