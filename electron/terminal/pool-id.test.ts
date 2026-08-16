import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionId, TerminalId } from '../../shared/ids'
import type { PtyLike } from './pool'
import { TerminalPool } from './pool'

class FakePty implements PtyLike {
  readonly pid = 123
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData() {
    return { dispose: () => undefined }
  }
  onExit() {
    return { dispose: () => undefined }
  }
}

const sessionA = 'session:a' as SessionId
const sessionB = 'session:b' as SessionId

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-terminal-id-'))
  let failSpawn = false
  const pool = new TerminalPool({
    getScrollbackBytes: () => 1_024,
    resolveShellProfile: async () => ({
      id: 'system-shell',
      kind: 'posix',
      label: 'sh',
      executable: '/bin/sh',
      source: 'system',
    }),
    spawnPty: () => {
      if (failSpawn) {
        failSpawn = false
        throw new Error('spawn failed')
      }
      return new FakePty()
    },
    emit: () => undefined,
  })
  return {
    root,
    pool,
    failNextSpawn: () => {
      failSpawn = true
    },
  }
}

// This file relies on Vitest per-file module isolation: the pool's process-wide
// id counter starts fresh here, so allocation observably begins at 1.
describe('TerminalPool id allocation', () => {
  it('starts at 1 and increments across Sessions without reusing closed ids', async () => {
    const { root, pool } = await harness()

    const first = await pool.open({ sessionId: sessionA, workspace: root })
    expect(first.terminalId).toBe(1 as TerminalId)

    const second = await pool.open({ sessionId: sessionB, workspace: root })
    expect(second.terminalId).toBe(2 as TerminalId)

    expect(pool.close(sessionA, first.terminalId)).toBe(true)
    const third = await pool.open({ sessionId: sessionA, workspace: root })
    expect(third.terminalId).toBe(3 as TerminalId)
  })

  it('leaves id holes when startup fails', async () => {
    const { root, pool, failNextSpawn } = await harness()

    const before = await pool.open({ sessionId: sessionA, workspace: root })
    failNextSpawn()
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('spawn failed')

    const next = await pool.open({ sessionId: sessionA, workspace: root })
    expect(next.terminalId).toBe((before.terminalId + 2) as TerminalId)
  })
})
