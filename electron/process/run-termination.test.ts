import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlledCommand } from './command-session-test-support'
import { terminateProcessTree } from './process-tree'
import { runCommand } from './run'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./process-tree', () => ({ terminateProcessTree: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('bounded runner termination ownership', () => {
  it('retains output ownership through stop failures and surfaces the failure after close', async () => {
    const child = new ControlledCommand()
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
    vi.mocked(terminateProcessTree).mockRejectedValue(
      new Error('host denied termination'),
    )
    const controller = new AbortController()
    let settled = false
    const running = runCommand({
      workspace: process.cwd(),
      command: { mode: 'process', executable: 'fixture' },
      timeoutMs: 10,
      terminationGraceMs: 1,
      maxOutputBytes: 1024,
      signal: controller.signal,
    }).finally(() => {
      settled = true
    })
    const rejected = expect(running).rejects.toThrow('host denied termination')
    await vi.waitFor(() =>
      expect(terminateProcessTree).toHaveBeenCalledTimes(2),
    )
    controller.abort()
    expect(
      vi.mocked(terminateProcessTree).mock.calls.map((call) => call[1]),
    ).toEqual([false, true])
    expect(settled).toBe(false)
    child.stdout.write('last output')
    child.close()
    await rejected
  })

  it('waits for an in-flight stop result even when child close arrives first', async () => {
    const child = new ControlledCommand()
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
    let finish!: () => void
    vi.mocked(terminateProcessTree).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    let settled = false
    const running = runCommand({
      workspace: process.cwd(),
      command: { mode: 'process', executable: 'fixture' },
      timeoutMs: 10,
      terminationGraceMs: 1,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() =>
      expect(terminateProcessTree).toHaveBeenCalledTimes(1),
    )
    child.close()
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    expect(await running).toMatchObject({ timedOut: true, exitCode: 0 })
    expect(terminateProcessTree).toHaveBeenCalledTimes(1)
  })
})
