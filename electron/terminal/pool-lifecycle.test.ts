import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { createTerminalHarness } from './terminal-test-support'

const owner = 'session:public' as SessionId
const child = 'session:hidden-child' as SessionId

describe('Background terminal cleanup', () => {
  it('retains closing ownership and the final log until actual exit and artifact settlement', async () => {
    const target = await createTerminalHarness()
    try {
      const terminal = await target.pool.open({
        sessionId: child,
        ownerSessionId: owner,
        workspace: target.root,
        sessionTemp: target.sessionTemp,
      })
      target.ptys[0]!.emitData('\u001b[31mfirst\u001b[0m\n')
      expect(target.pool.cancelBackground(owner, terminal.terminalId)).toBe(
        true,
      )
      let exited = false
      const wait = target.pool
        .waitForExit(owner, terminal.terminalId)
        .then(() => {
          exited = true
        })
      await Promise.resolve()
      expect(exited).toBe(false)
      expect(
        target.pool.backgroundSnapshot(owner, terminal.terminalId).status,
      ).toBe('closing')
      expect(target.pool.write(child, terminal.terminalId, 'ignored')).toBe(
        false,
      )
      target.ptys[0]!.emitData('最后一行😀\n')
      target.ptys[0]!.emitExit(7)
      expect(
        target.pool.backgroundSnapshot(owner, terminal.terminalId).status,
      ).toBe('closing')
      await wait
      expect(
        target.pool.backgroundSnapshot(owner, terminal.terminalId),
      ).toMatchObject({
        status: 'closed',
        exitCode: 7,
        artifactAvailable: true,
      })
      expect(target.pool.list(child)).toEqual([])
      expect(await readFile(terminal.artifactPath!, 'utf8')).toBe(
        'first\n最后一行😀\n',
      )
      expect(
        target.pool.readBackground(owner, terminal.terminalId, {
          maxBytes: 1000,
        }).content,
      ).toBe('first\n最后一行😀\n')
    } finally {
      await target.dispose()
    }
  })

  it('blocks new child terminals while preserving sibling and public terminals', async () => {
    const target = await createTerminalHarness()
    try {
      const first = await target.pool.open({
        sessionId: child,
        ownerSessionId: owner,
        workspace: target.root,
      })
      const sibling = await target.pool.open({
        sessionId: 'session:sibling' as SessionId,
        ownerSessionId: owner,
        workspace: target.root,
      })
      const manual = await target.pool.open({
        sessionId: owner,
        workspace: target.root,
      })
      target.pool.closeSession(child, true)
      await expect(
        target.pool.open({
          sessionId: child,
          ownerSessionId: owner,
          workspace: target.root,
        }),
      ).rejects.toThrow('stopping')
      expect(
        target.pool.backgroundSnapshot(owner, first.terminalId).status,
      ).toBe('closing')
      expect(
        target.pool.backgroundSnapshot(owner, sibling.terminalId).status,
      ).toBe('running')
      expect(
        target.pool.backgroundSnapshot(owner, manual.terminalId).status,
      ).toBe('running')
      expect(target.pool.list(owner)).toHaveLength(1)
    } finally {
      await target.dispose()
    }
  })

  it('does not report a kill failure as a completed terminal and accepts a retry', async () => {
    const target = await createTerminalHarness()
    try {
      const terminal = await target.pool.open({
        sessionId: owner,
        workspace: target.root,
      })
      target.ptys[0]!.failKill = true
      expect(() =>
        target.pool.cancelBackground(owner, terminal.terminalId),
      ).toThrow('PTY kill failed')
      expect(
        target.pool.backgroundSnapshot(owner, terminal.terminalId).status,
      ).toBe('running')
      target.ptys[0]!.failKill = false
      expect(target.pool.cancelBackground(owner, terminal.terminalId)).toBe(
        true,
      )
      target.ptys[0]!.emitExit()
      await target.pool.waitForExit(owner, terminal.terminalId)
      expect(
        target.pool.backgroundSnapshot(owner, terminal.terminalId).status,
      ).toBe('closed')
    } finally {
      await target.dispose()
    }
  })
})
