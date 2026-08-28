import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { SessionTempService, writeSessionArtifactText } from './service'

describe('SessionTempService', () => {
  it('creates deterministic private roots and removes them on permanent deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'session-temp-service-'))
    const service = new SessionTempService({ rootDirectory: root })
    await service.initialize()
    const sessionId = 'session:private' as SessionId
    const first = await service.ensureSession(sessionId)
    const second = await service.ensureSession(sessionId)

    expect(second).toEqual(first)
    if (process.platform !== 'win32') {
      expect((await stat(first.root)).mode & 0o777).toBe(0o700)
      expect((await stat(first.scratch)).mode & 0o777).toBe(0o700)
    }
    const artifact = await service.writeText(
      sessionId,
      ['commands', 'call', 'stdout.log'],
      'complete output',
    )
    if (process.platform !== 'win32') {
      expect((await stat(artifact)).mode & 0o777).toBe(0o600)
    }

    await service.removeSession(sessionId)
    await expect(stat(first.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans only real Session directories older than 24 hours', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'session-temp-cleanup-'))
    const expired = path.join(root, 'expired')
    const fresh = path.join(root, 'fresh')
    await Promise.all([mkdir(expired), mkdir(fresh)])
    await writeFile(path.join(expired, 'artifact.log'), 'old')
    const now = Date.parse('2026-08-28T00:00:00.000Z')
    const old = new Date(now - 25 * 60 * 60_000)
    await utimes(expired, old, old)
    const service = new SessionTempService({
      rootDirectory: root,
      now: () => now,
    })

    await service.initialize()

    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(fresh)).resolves.toBeDefined()
  })

  it('refreshes retention age when an artifact is written directly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'session-temp-touch-'))
    const sessionTemp = {
      root,
      artifacts: path.join(root, 'artifacts'),
      scratch: path.join(root, 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const old = new Date('2026-08-20T00:00:00.000Z')
    await utimes(root, old, old)

    await writeSessionArtifactText(
      sessionTemp,
      ['commands', 'call', 'stdout.log'],
      'recent output',
    )

    expect((await stat(root)).mtimeMs).toBeGreaterThan(old.getTime())
  })
})
