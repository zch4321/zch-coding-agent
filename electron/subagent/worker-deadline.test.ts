import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerDeadline } from './worker-deadline'

afterEach(() => vi.useRealTimers())

describe('worker execution allowance', () => {
  it('excludes approval and parked time, and grants an allowance only on resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const expired = vi.fn()
    const deadline = new WorkerDeadline(100, expired)
    await vi.advanceTimersByTimeAsync(30)
    deadline.phase('awaiting_approval')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(expired).not.toHaveBeenCalled()
    deadline.phase('running_tools')
    await vi.advanceTimersByTimeAsync(69)
    expect(expired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(expired).toHaveBeenCalledOnce()
    deadline.phase('paused')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(expired).toHaveBeenCalledOnce()
    deadline.reset()
    await vi.advanceTimersByTimeAsync(99)
    expect(expired).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(expired).toHaveBeenCalledTimes(2)
    deadline.dispose()
    deadline.reset()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(expired).toHaveBeenCalledTimes(2)
  })
})
