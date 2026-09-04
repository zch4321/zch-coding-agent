import { afterEach, describe, expect, it, vi } from 'vitest'
import { delay } from './delay'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('delay', () => {
  it('resolves only after the requested timer delay', async () => {
    vi.useFakeTimers()
    let completed = false
    const waiting = delay(100).then(() => {
      completed = true
    })

    await vi.advanceTimersByTimeAsync(99)
    expect(completed).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(completed).toBe(true)
  })

  it('keeps a zero duration asynchronous', async () => {
    vi.useFakeTimers()
    let completed = false
    const waiting = delay(0).then(() => {
      completed = true
    })

    await Promise.resolve()
    expect(completed).toBe(false)

    await vi.runOnlyPendingTimersAsync()
    await waiting
    expect(completed).toBe(true)
  })

  it('rejects an already-aborted wait without arming a timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('cancelled before waiting')
    controller.abort(reason)

    await expect(delay(10_000, controller.signal)).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending timer and preserves the abort reason', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('cancelled while waiting')
    const waiting = delay(10_000, controller.signal)

    expect(vi.getTimerCount()).toBe(1)
    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes the abort listener after the timer completes', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(
      controller.signal,
      'removeEventListener',
    )
    const waiting = delay(10, controller.signal)

    await vi.advanceTimersByTimeAsync(10)
    await waiting

    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    )
  })
})
