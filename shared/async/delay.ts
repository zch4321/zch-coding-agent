function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('Delay was aborted')
  error.name = 'AbortError'
  return error
}

/** Resolves after one timer delay, or rejects with the AbortSignal reason when cancelled. */
export function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, durationMs)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortReason(signal!))
    }

    signal?.addEventListener('abort', abort, { once: true })
  })
}
