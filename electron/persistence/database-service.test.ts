import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  DatabaseService,
  desktopDatabasePath,
  headlessTrialDatabasePath,
  migrationChecksum,
} from './database-service'
import { DATABASE_MIGRATIONS, type DatabaseMigration } from './migrations'
import { PersistenceError } from './persistence-error'
import { createTestDatabase } from './test-database'

describe('DatabaseService', () => {
  it('opens a file database with required pragmas and migration metadata', async () => {
    const testDatabase = await createTestDatabase({
      appVersion: '0.2.3',
      now: () => '2026-07-22T00:00:00.000Z',
    })

    try {
      const pragmas = testDatabase.database.read((reader) => ({
        foreignKeys: reader.prepare('PRAGMA foreign_keys').get(),
        journalMode: reader.prepare('PRAGMA journal_mode').get(),
        busyTimeout: reader.prepare('PRAGMA busy_timeout').get(),
      }))
      const migration = testDatabase.database.read((reader) =>
        reader.prepare('SELECT * FROM schema_migrations').get(),
      )

      expect(pragmas).toEqual({
        foreignKeys: { foreign_keys: 1 },
        journalMode: { journal_mode: 'wal' },
        busyTimeout: { timeout: 5_000 },
      })
      expect(migration).toMatchObject({
        version: 1,
        name: '0001_initial',
        checksum_sha256: migrationChecksum(DATABASE_MIGRATIONS[0]!.sql),
        app_version: '0.2.3',
        applied_at: '2026-07-22T00:00:00.000Z',
      })
    } finally {
      await testDatabase.dispose()
    }
  })

  it('reopens an already migrated database without reapplying migrations', async () => {
    const testDatabase = await createTestDatabase()
    const databasePath = testDatabase.databasePath

    await testDatabase.database.close()
    const reopened = DatabaseService.open({
      databasePath,
      appVersion: 'test-2',
    })
    try {
      const count = reopened.read((reader) =>
        reader.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
      )
      expect(count).toEqual({ count: 1 })
    } finally {
      await reopened.close()
      await testDatabase.dispose()
    }
  })

  it('rejects changed checksums for applied migrations', async () => {
    const testDatabase = await createTestDatabase()
    const databasePath = testDatabase.databasePath
    await testDatabase.database.close()

    expect(() =>
      DatabaseService.open({
        databasePath,
        appVersion: 'test',
        migrations: [
          {
            ...DATABASE_MIGRATIONS[0]!,
            sql: `${DATABASE_MIGRATIONS[0]!.sql}\n-- modified`,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH' }),
    )
    await testDatabase.dispose()
  })

  it('rejects a database created by a newer migration set', async () => {
    const migrations: DatabaseMigration[] = [
      DATABASE_MIGRATIONS[0]!,
      {
        version: 2,
        name: '0002_future',
        sql: 'CREATE TABLE future_state (id TEXT PRIMARY KEY) STRICT;',
      },
    ]
    const testDatabase = await createTestDatabase({ migrations })
    const databasePath = testDatabase.databasePath
    await testDatabase.database.close()

    expect(() =>
      DatabaseService.open({ databasePath, appVersion: 'older-app' }),
    ).toThrowError(
      expect.objectContaining({ code: 'DATABASE_VERSION_TOO_NEW' }),
    )
    await testDatabase.dispose()
  })

  it('rejects a gap in applied migration history', async () => {
    const migrations: DatabaseMigration[] = [
      DATABASE_MIGRATIONS[0]!,
      {
        version: 2,
        name: '0002_second',
        sql: 'CREATE TABLE second_step (id TEXT PRIMARY KEY) STRICT;',
      },
      {
        version: 3,
        name: '0003_third',
        sql: 'CREATE TABLE third_step (id TEXT PRIMARY KEY) STRICT;',
      },
    ]
    const testDatabase = await createTestDatabase({ migrations })
    const databasePath = testDatabase.databasePath
    await testDatabase.database.withTransaction((transaction) => {
      transaction
        .prepare('DELETE FROM schema_migrations WHERE version = ?')
        .run(2)
    })
    await testDatabase.database.close()

    expect(() =>
      DatabaseService.open({
        databasePath,
        appVersion: 'test',
        migrations,
      }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_INVALID' }))
    await testDatabase.dispose()
  })

  it('rolls back a failed migration step without recording it', async () => {
    const first = await createTestDatabase()
    const databasePath = first.databasePath
    await first.database.close()
    const brokenMigrations: DatabaseMigration[] = [
      DATABASE_MIGRATIONS[0]!,
      {
        version: 2,
        name: '0002_broken',
        sql: `
          CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT;
          INSERT INTO table_that_does_not_exist VALUES (1);
        `,
      },
    ]

    expect(() =>
      DatabaseService.open({
        databasePath,
        appVersion: 'test',
        migrations: brokenMigrations,
      }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_FAILED' }))

    const raw = new DatabaseSync(databasePath)
    try {
      expect(
        raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'should_rollback'`,
          )
          .get(),
      ).toBeUndefined()
      expect(
        raw.prepare('SELECT count(*) AS count FROM schema_migrations').get(),
      ).toEqual({ count: 1 })
    } finally {
      raw.close()
      await first.dispose()
    }
  })

  it('serializes transactions and rolls back failed work', async () => {
    const testDatabase = await createTestDatabase()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        transaction.exec(
          'CREATE TABLE transaction_probe (id INTEGER PRIMARY KEY) STRICT;',
        )
      })
      const first = testDatabase.database.withTransaction((transaction) => {
        transaction
          .prepare('INSERT INTO transaction_probe (id) VALUES (?)')
          .run(1)
        return 'first'
      })
      const second = testDatabase.database.withTransaction((transaction) => {
        const row = transaction
          .prepare('SELECT count(*) AS count FROM transaction_probe')
          .get()
        transaction
          .prepare('INSERT INTO transaction_probe (id) VALUES (?)')
          .run(2)
        return row
      })

      await expect(first).resolves.toBe('first')
      await expect(second).resolves.toEqual({ count: 1 })
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          transaction
            .prepare('INSERT INTO transaction_probe (id) VALUES (?)')
            .run(3)
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(
        testDatabase.database.read((reader) =>
          reader.prepare('SELECT id FROM transaction_probe ORDER BY id').all(),
        ),
      ).toEqual([{ id: 1 }, { id: 2 }])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('rejects async transaction callbacks and work after close', async () => {
    const testDatabase = await createTestDatabase()

    await expect(
      testDatabase.database.withTransaction(async () => 'not allowed'),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'ASYNC_TRANSACTION_NOT_ALLOWED' }),
    )
    await testDatabase.database.close()
    expect(() => testDatabase.database.read(() => undefined)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_CLOSED' }),
    )
    await expect(
      testDatabase.database.withTransaction(() => undefined),
    ).rejects.toThrowError(expect.objectContaining({ code: 'DATABASE_CLOSED' }))
    await testDatabase.dispose()
  })

  it('validates migration ordering and derives isolated database paths', () => {
    expect(() =>
      DatabaseService.open({
        databasePath: ':memory:',
        appVersion: 'test',
        migrations: [{ version: 2, name: '0002_wrong', sql: 'SELECT 1;' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_INVALID' }))
    expect(() =>
      DatabaseService.open({
        databasePath: ':memory:',
        appVersion: 'test',
        migrations: [{ version: 1, name: '0002_wrong', sql: 'SELECT 1;' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_INVALID' }))
    expect(desktopDatabasePath('C:\\UserData')).toBe('C:\\UserData\\agent.db')
    expect(headlessTrialDatabasePath('C:\\trial-42')).toBe(
      'C:\\trial-42\\agent.db',
    )
  })

  it('exposes typed persistence errors', () => {
    const error = new PersistenceError('CODEC_INVALID', 'invalid row')
    expect(error).toMatchObject({
      name: 'PersistenceError',
      code: 'CODEC_INVALID',
      message: 'invalid row',
    })
  })
})
