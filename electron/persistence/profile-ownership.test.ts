import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileOwnership } from './profile-ownership'
import { DatabaseService } from './database-service'

let directory: string
const leases: ProfileOwnership[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function databasePath() {
  directory = await mkdtemp(path.join(os.tmpdir(), 'zch-profile-owner-'))
  return path.join(directory, 'agent.db')
}

function acquire(file: string) {
  const lease = ProfileOwnership.acquire(file)
  leases.push(lease)
  return lease
}

describe('shared profile ownership', () => {
  it('rejects a second owner before migrations, permits independent profiles, and releases idempotently', async () => {
    const file = await databasePath()
    const owner = acquire(file)
    expect(() => acquire(file)).toThrowError(
      expect.objectContaining({ code: 'PROFILE_IN_USE' }),
    )
    const other = acquire(path.join(directory, 'other.db'))
    other.release()
    const database = DatabaseService.open({
      databasePath: file,
      appVersion: 'test',
    })
    await database.close()
    owner.release()
    owner.release()
    const next = acquire(file)
    next.assertOwned(file)
    expect(() => owner.assertOwned(file)).toThrow('ownership')
    expect(() => next.assertOwned(path.join(directory, 'wrong.db'))).toThrow(
      'ownership',
    )
  })

  it('blocks a live process and reclaims its lease only after confirmed exit', async () => {
    const file = await databasePath()
    acquire(file).release()
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { DatabaseSync } from 'node:sqlite'
      const db = new DatabaseSync(process.argv[1])
      db.prepare('INSERT INTO backend_profile_owner(singleton,pid,token) VALUES(1,?,?)').run(process.pid, 'child-owner')
      process.stdout.write('ready')
      setInterval(() => {}, 1000)
    `,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    await once(child.stdout!, 'data')
    expect(() => acquire(file)).toThrowError(
      expect.objectContaining({ code: 'PROFILE_IN_USE' }),
    )
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const next = acquire(file)
    next.assertOwned(file)
  })

  it('reports corruption without replacing the database', async () => {
    const file = await databasePath()
    await writeFile(file, 'invalid sqlite sentinel')
    expect(() => acquire(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_CORRUPT' }),
    )
  })
})
