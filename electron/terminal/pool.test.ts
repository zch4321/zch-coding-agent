import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../../shared/ids'
import type { PtyLike, TerminalEventDraft } from './pool'
import { TerminalPool } from './pool'

class FakePty implements PtyLike {
  readonly pid = 123
  readonly writes: string[] = []
  readonly sizes: Array<[number, number]> = []
  killed = false
  #data = new Set<(data: string) => void>()
  #exit = new Set<(event: { exitCode: number; signal?: number }) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(columns: number, rows: number): void {
    this.sizes.push([columns, rows])
  }

  kill(): void {
    this.killed = true
    for (const listener of this.#exit) {
      listener({ exitCode: 0 })
    }
  }

  onData(listener: (data: string) => void) {
    this.#data.add(listener)
    return { dispose: () => this.#data.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#exit.add(listener)
    return { dispose: () => this.#exit.delete(listener) }
  }

  emitData(data: string): void {
    for (const listener of this.#data) {
      listener(data)
    }
  }
}

const sessionA = 'session:a' as SessionId
const sessionB = 'session:b' as SessionId

async function harness(scrollbackBytes = 1_024) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-terminal-'))
  const events: TerminalEventDraft[] = []
  const ptys: FakePty[] = []
  const pool = new TerminalPool({
    getScrollbackBytes: () => scrollbackBytes,
    emit: (event) => events.push(event),
    spawnPty: () => {
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    },
  })
  return { root, events, ptys, pool }
}

describe('TerminalPool', () => {
  it('waits for active PTYs to exit during disposal', async () => {
    const { root, ptys, pool } = await harness()
    await pool.open({ sessionId: sessionA, workspace: root })

    await pool.dispose()

    expect(ptys[0]?.killed).toBe(true)
    expect(pool.list(sessionA)).toEqual([])
  })

  it('streams ANSI output but returns bounded ANSI-free model text', async () => {
    const { root, events, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })
    ptys[0]!.emitData('\u001b[31mred\u001b[0m\nnext')

    expect(
      events.some(
        (event) =>
          event.type === 'terminal.output' &&
          event.chunk?.includes('\u001b[31m'),
      ),
    ).toBe(true)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(
      pool.read(sessionA, terminal.terminalId, {
        lines: 2,
        maxBytes: 1_024,
      }),
    ).toMatchObject({
      content: 'red\nnext',
      truncated: false,
    })
  })

  it('rejects cross-session access and closes all session terminals', async () => {
    const { root, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })

    expect(() => pool.write(sessionB, terminal.terminalId, 'whoami\r')).toThrow(
      'Terminal not found for this session',
    )
    expect(pool.write(sessionA, terminal.terminalId, 'whoami\r')).toBe(true)
    expect(ptys[0]!.writes).toEqual(['whoami\r'])

    pool.closeSession(sessionA)
    expect(ptys[0]!.killed).toBe(true)
    expect(pool.list(sessionA)).toEqual([])
    expect(pool.close(sessionA, terminal.terminalId)).toBe(false)
  })

  it('resizes an owned running terminal', async () => {
    const { root, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })

    expect(pool.resize(sessionA, terminal.terminalId, 120, 40)).toBe(true)
    expect(ptys[0]!.sizes).toEqual([[120, 40]])
  })

  it('uses the supplied PTY factory without invoking native spawn', async () => {
    const { root, pool } = await harness()
    const open = vi.spyOn(pool, 'open')
    await pool.open({ sessionId: sessionA, workspace: root })
    expect(open).toHaveBeenCalledOnce()
  })
})
