import type { AgentExecutionId, SessionId } from '../../shared/ids'

interface Waiter {
  owner: SessionId
  execution: AgentExecutionId
  limit: number
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
  abort: () => void
}

/** Owns process-local worker reservations; parked Runs retain identity but release their slot. */
export class SubagentCapacity {
  readonly #held = new Map<AgentExecutionId, SessionId>()
  readonly #waiting: Waiter[] = []

  /** Atomically reserves every requested initial worker or leaves the registry unchanged. */
  reserve(
    owner: SessionId,
    ids: readonly AgentExecutionId[],
    limit: number,
  ): boolean {
    for (const id of ids)
      if (this.#held.has(id) && this.#held.get(id) !== owner)
        throw new Error('Worker reservation ownership changed')
    const fresh = [...new Set(ids)].filter((id) => !this.#held.has(id))
    if (this.count(owner) + fresh.length > limit) return false
    for (const id of fresh) this.#held.set(id, owner)
    return true
  }

  /** Counts only reserved or executing model workers for one parent Session. */
  count(owner: SessionId): number {
    return [...this.#held.values()].filter((value) => value === owner).length
  }

  /** Releases a settled or parked worker and admits waiting continuations in arrival order. */
  release(execution: AgentExecutionId): void {
    this.#held.delete(execution)
    this.#drain()
  }

  /** Waits for a continuation slot without charging worker time or occupying a tool body. */
  acquire(
    owner: SessionId,
    execution: AgentExecutionId,
    limit: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (this.reserve(owner, [execution], limit)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        owner,
        execution,
        limit,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiting.indexOf(waiter)
          if (index >= 0) this.#waiting.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(signal.reason)
        },
      }
      this.#waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }

  #drain(): void {
    for (const waiter of [...this.#waiting]) {
      if (waiter.signal.aborted) {
        waiter.abort()
        continue
      }
      if (!this.reserve(waiter.owner, [waiter.execution], waiter.limit))
        continue
      this.#waiting.splice(this.#waiting.indexOf(waiter), 1)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve()
    }
  }
}
