import { describe, expect, it, vi } from 'vitest'
import { Disposer } from './disposer'

describe('Disposer', () => {
  it('runs resources in reverse order and isolates individual failures', async () => {
    const calls: string[] = []
    const onError = vi.fn()
    const disposer = new Disposer({ onError })

    disposer.add(() => {
      calls.push('first')
    })
    disposer.add(() => {
      calls.push('second')
      throw new Error('cleanup failed')
    })
    disposer.add(async () => {
      calls.push('third')
    })

    const report = await disposer.dispose()

    expect(calls).toEqual(['third', 'second', 'first'])
    expect(report).toEqual({
      completed: 2,
      failed: 1,
      skipped: 0,
      timedOut: false,
    })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('is idempotent and does not release a resource twice', async () => {
    const release = vi.fn()
    const disposer = new Disposer()

    disposer.add(release)

    const first = disposer.dispose()
    const second = disposer.dispose()

    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ completed: 1 })
    expect(release).toHaveBeenCalledOnce()
  })

  it('stops waiting when the total timeout is reached', async () => {
    const calls: string[] = []
    const disposer = new Disposer({ timeoutMs: 20 })

    disposer.add(() => {
      calls.push('skipped')
    })
    disposer.add(() => new Promise<void>(() => undefined))

    const report = await disposer.dispose()

    expect(calls).toEqual([])
    expect(report).toEqual({
      completed: 0,
      failed: 0,
      skipped: 1,
      timedOut: true,
    })
  })
})
