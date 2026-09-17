/** Serializes controls per identity and deduplicates only already accepted parent tool calls. */
export class ControlAdmission {
  readonly #locks = new Map<string, Promise<unknown>>()
  readonly #calls = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown>; settled: boolean }
  >()

  /** Runs a control once, retaining a bounded cache without evicting in-flight admissions. */
  run<T>(
    identity: string,
    call: string,
    fingerprint: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#calls.get(call)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(new Error('Control call arguments changed'))
      return previous.promise as Promise<T>
    }
    const promise = (this.#locks.get(identity) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action)
    const entry = { fingerprint, promise, settled: false }
    this.#calls.set(call, entry)
    this.#locks.set(identity, promise)
    void promise
      .finally(() => {
        entry.settled = true
        if (this.#locks.get(identity) === promise) this.#locks.delete(identity)
        while (this.#calls.size > 2048) {
          const oldest = [...this.#calls].find(
            ([, candidate]) => candidate.settled,
          )
          if (!oldest) break
          this.#calls.delete(oldest[0])
        }
      })
      .catch(() => undefined)
    return promise
  }
}
