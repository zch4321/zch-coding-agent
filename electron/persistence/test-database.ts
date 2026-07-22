import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DatabaseService,
  type DatabaseServiceOptions,
} from './database-service'

export interface TestDatabase {
  directory: string
  databasePath: string
  database: DatabaseService
  dispose(): Promise<void>
}

export async function createTestDatabase(
  options: Partial<Omit<DatabaseServiceOptions, 'databasePath'>> = {},
): Promise<TestDatabase> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'zch-persistence-test-'),
  )
  const databasePath = path.join(directory, 'agent.test.db')
  const database = DatabaseService.open({
    databasePath,
    appVersion: options.appVersion ?? 'test',
    ...(options.migrations ? { migrations: options.migrations } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  let disposed = false

  return {
    directory,
    databasePath,
    database,
    async dispose() {
      if (disposed) return
      disposed = true
      await database.close()
      await rm(directory, { force: true, recursive: true })
    },
  }
}
