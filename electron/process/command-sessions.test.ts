import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandOutput } from './command-output'
import type { terminateProcessTree } from './process-tree'
import {
  commandInput,
  commandOwner,
  controlledCommands,
} from './command-session-test-support'

const fixtures: ReturnType<typeof controlledCommands>[] = []
function fixture(options?: Parameters<typeof controlledCommands>[0]) {
  const value = controlledCommands(options)
  fixtures.push(value)
  const owner = commandOwner(String(fixtures.length))
  const controller = new AbortController()
  value.manager.beginRun(owner, controller.signal)
  return { ...value, owner, controller }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const value of fixtures.splice(0)) {
    for (const child of value.children) child.close()
    await value.manager.dispose()
  }
})

describe('Run-owned command sessions', () => {
  it('yields without killing, consumes output once, and isolates Session/Run ownership', async () => {
    const { manager, children, stops, owner } = fixture()
    const id = await manager.start(owner, commandInput())
    const signal = new AbortController().signal
    children[0]!.stdout.write('before wait')
    expect(await manager.read(owner, id, 0, signal)).toMatchObject({
      state: 'running',
      stdout: 'before wait',
      exitCode: null,
    })
    expect(await manager.read(owner, id, 1, signal)).toMatchObject({
      stdout: '',
      state: 'running',
    })
    expect(stops).toHaveLength(0)
    const other = commandOwner('other')
    manager.beginRun(other, signal)
    expect(() => manager.describe(other, id)).toThrow(/not found/u)
    expect(() =>
      manager.terminate({ ...owner, sessionId: other.sessionId }, id),
    ).toThrow(/not found/u)
    children[0]!.stderr.write('last error')
    children[0]!.close(7)
    expect(await manager.read(owner, id, 100, signal)).toMatchObject({
      state: 'exited',
      stdout: '',
      stderr: 'last error',
      exitCode: 7,
    })
    await manager.finishRun(owner)
    expect(() => manager.describe(owner, id)).toThrow(/not found/u)
  })

  it('orders raw stdin bytes, closes stdin with EOF, and rejects further input', async () => {
    const { manager, children, owner } = fixture()
    const id = await manager.start(owner, commandInput())
    manager.write(owner, id, 'y')
    manager.write(owner, id, '\n\u0003', true)
    expect(Buffer.concat(children[0]!.input).toString()).toBe('y\n\u0003')
    expect(() => manager.write(owner, id, 'again')).toThrow(
      /no longer accepts/u,
    )
    expect(() => manager.write(owner, 'missing', 'again')).toThrow(/not found/u)
  })

  it('wakes an existing wait on stop and waits for actual close on subsequent sampling', async () => {
    const { manager, children, owner, stops } = fixture()
    const id = await manager.start(owner, commandInput())
    const signal = new AbortController().signal
    const waiting = manager.read(owner, id, 60_000, signal)
    manager.terminate(owner, id)
    expect(await waiting).toMatchObject({ state: 'stopping' })
    expect(stops).toHaveLength(1)
    let settled = false
    const finishing = manager.read(owner, id, 60_000, signal).then((result) => {
      settled = true
      return result
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    children[0]!.stdout.write('final chunk')
    children[0]!.close()
    expect(await finishing).toMatchObject({
      state: 'exited',
      stdout: 'final chunk',
    })
    manager.terminate(owner, id)
  })

  it('keeps the Run owned until delayed artifact completion and blocks late launches/writes', async () => {
    let finish!: () => void
    const capture = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { manager, children, owner } = fixture({
      finishCapture: async () => {
        await capture
        return { artifactAvailable: true, artifactPath: '/registered/result' }
      },
    })
    const id = await manager.start(owner, commandInput())
    let finished = false
    const done = manager.finishRun(owner).then(() => {
      finished = true
    })
    await expect(manager.start(owner, commandInput())).rejects.toThrow(
      /finishing/u,
    )
    expect(() => manager.write(owner, id, 'late')).toThrow(/finishing/u)
    children[0]!.close()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(
      await manager.read(owner, id, 0, new AbortController().signal),
    ).toMatchObject({ state: 'stopping' })
    finish()
    await done
    expect(finished).toBe(true)
  })

  it('cancels a reserved launch before spawn and releases its unused capacity', async () => {
    const { manager, owner, children, controller } = fixture()
    const starting = manager.start(owner, commandInput())
    controller.abort()
    await expect(starting).rejects.toThrow(/finishing/u)
    await manager.finishRun(owner)
    expect(children).toHaveLength(0)
  })

  it('reserves 16 slots atomically and retains them through delayed exit', async () => {
    const { manager, children, owner } = fixture()
    const attempts = Array.from({ length: 17 }, () =>
      manager.start(owner, commandInput()),
    )
    const results = await Promise.allSettled(attempts)
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      16,
    )
    const first = results[0]!
    if (first.status !== 'fulfilled') throw Error('first launch failed')
    manager.terminate(owner, first.value)
    await expect(manager.start(owner, commandInput())).rejects.toThrow(
      /16 active/u,
    )
    children[0]!.close()
    await manager.read(owner, first.value, 100, new AbortController().signal)
    await expect(manager.start(owner, commandInput())).resolves.toMatch(
      /^exec:/u,
    )
  })

  it('retains stop failures, retries on another stop request, and escalates after grace', async () => {
    const terminate = vi.fn<typeof terminateProcessTree>(async () => {
      throw Error('host denied termination')
    })
    const diagnostic = vi.fn()
    const { manager, children, owner } = fixture({
      terminate,
      onDiagnostic: diagnostic,
      terminationGraceMs: 1,
    })
    const id = await manager.start(owner, commandInput())
    manager.terminate(owner, id)
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(2))
    expect(terminate.mock.calls[1]?.[1]).toBe(true)
    expect(
      await manager.read(owner, id, 0, new AbortController().signal),
    ).toMatchObject({ state: 'stopping', stopError: 'host denied termination' })
    expect(diagnostic).toHaveBeenCalled()
    terminate.mockImplementation(async () => {
      children[0]!.close()
    })
    manager.terminate(owner, id)
    expect(
      await manager.read(owner, id, 100, new AbortController().signal),
    ).toMatchObject({ state: 'exited' })
  })

  it('does not consume output when a waiting call is aborted', async () => {
    const { manager, children, owner } = fixture()
    const id = await manager.start(owner, commandInput())
    const waiting = new AbortController()
    const read = manager.read(owner, id, 60_000, waiting.signal)
    children[0]!.stdout.write('not yet returned')
    waiting.abort(new Error('interrupted wait'))
    await expect(read).rejects.toThrow('interrupted wait')
    expect(
      await manager.read(owner, id, 0, new AbortController().signal),
    ).toMatchObject({ state: 'running', stdout: 'not yet returned' })
  })

  it('bounded finished history evicts old handles without reusing them', async () => {
    const { manager, children, owner } = fixture()
    let first = ''
    let last = ''
    for (let index = 0; index < 257; index++) {
      last = await manager.start(owner, commandInput())
      first ||= last
      children[index]!.close()
      await manager.read(owner, last, 100, new AbortController().signal)
    }
    expect(() => manager.describe(owner, first)).toThrow(/expired/u)
    expect(manager.describe(owner, last)).toMatchObject({
      executable: 'fixture',
    })
  })
})

describe('incremental command output', () => {
  it('preserves split Chinese characters, bounds unread memory, and reports loss once', () => {
    const output = new CommandOutput(12)
    const chinese = Buffer.from('中文')
    output.append('stdout', chinese.subarray(0, 2))
    expect(output.read().stdout).toBe('')
    output.append('stdout', chinese.subarray(2))
    expect(output.read().stdout).toBe('中文')
    output.append('stdout', Buffer.from('中'.repeat(30)))
    expect(output.read()).toMatchObject({
      stdout: '中'.repeat(4),
      truncated: true,
    })
    expect(output.read()).toMatchObject({ stdout: '', truncated: false })
  })

  it('supports split legacy encoding without affecting UTF-8 streams', () => {
    const output = new CommandOutput(4096, 'gb18030')
    output.append('stdout', Buffer.from([0xd6]))
    output.append('stdout', Buffer.from([0xd0, 0xce, 0xc4]))
    output.append('stderr', Buffer.from('中文'))
    output.finish()
    expect(output.read()).toMatchObject({ stdout: '中文', stderr: '中文' })
  })
})
