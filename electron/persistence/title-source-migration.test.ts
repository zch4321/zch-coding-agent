import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DatabaseService } from './database-service'
import { DATABASE_MIGRATIONS } from './migrations'
import { ProjectRepository } from './project-repository'
import {
  insertLegacySession,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { createTestDatabase } from './test-database'

describe('0009_title_source migration', () => {
  it('defaults existing sessions to user titles and stores new title sources', async () => {
    const legacy = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 8),
    })
    const project = projectFixture()
    const session = sessionFixture()
    const projects = new ProjectRepository()
    const sessions = new SessionRepository()
    await legacy.database.withTransaction((transaction) => {
      projects.insert(transaction, project)
      // v8 rows predate title_source; insert through the pre-0009 column list.
      insertLegacySession(transaction, session)
    })
    const databasePath = legacy.databasePath
    const directory = legacy.directory
    await legacy.database.close()

    const upgraded = DatabaseService.open({
      databasePath,
      appVersion: 'title-source-migration-test',
    })
    try {
      expect(
        upgraded.read((reader) =>
          reader
            .prepare(
              'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1',
            )
            .get(),
        ),
      ).toEqual({ version: 9, name: '0009_title_source' })

      // Rows that existed before the migration keep their titles unmanaged.
      expect(
        upgraded.read((reader) => sessions.get(reader, session.id)),
      ).toMatchObject({
        title: session.title,
        titleSource: 'user',
      })

      // New rows persist their explicit title source.
      const fresh = sessionFixture({
        id: 'session:fresh' as never,
        titleSource: 'auto',
      })
      await upgraded.withTransaction((transaction) => {
        sessions.insert(transaction, fresh)
      })
      expect(
        upgraded.read((reader) => sessions.get(reader, fresh.id))?.titleSource,
      ).toBe('auto')
    } finally {
      await upgraded.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
