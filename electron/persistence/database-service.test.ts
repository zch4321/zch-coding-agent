import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DatabaseService,
  desktopDatabasePath,
  headlessTrialDatabasePath,
  migrationChecksum,
} from './database-service'
import { DATABASE_MIGRATIONS, type DatabaseMigration } from './migrations'
import {
  normalizePersistenceError,
  PersistenceError,
} from './persistence-error'
import { createTestDatabase } from './test-database'
import { ProjectRepository } from './project-repository'
import { SessionRepository } from './session-repository'
import {
  fileChangeFixture,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { encodeStoredFileChangeRow } from './file-change-codec'
import { FileChangeRepository } from './file-change-repository'

describe('DatabaseService', () => {
  it.each([
    [5, 'DATABASE_BUSY'],
    [8, 'DATABASE_IO'],
    [10, 'DATABASE_IO'],
    [13, 'DATABASE_IO'],
    [14, 'DATABASE_IO'],
    [11, 'DATABASE_CORRUPT'],
    [19, 'DATABASE_CONSTRAINT'],
    [1, 'DATABASE_ERROR'],
  ] as const)('maps SQLite primary code %i to %s', (errcode, code) => {
    const sqliteError = Object.assign(new Error('sqlite fixture'), {
      code: 'ERR_SQLITE_ERROR',
      errcode,
    })

    expect(normalizePersistenceError(sqliteError)).toMatchObject({ code })
  })

  it('reports corrupt files and unwritable database paths with stable codes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-database-errors-'))
    try {
      const corruptPath = path.join(root, 'corrupt.db')
      await writeFile(corruptPath, 'not a sqlite database', 'utf8')
      expect(() =>
        DatabaseService.open({
          databasePath: corruptPath,
          appVersion: 'test',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'DATABASE_CORRUPT',
          message: expect.stringContaining('corrupt or invalid'),
        }),
      )

      const fileInsteadOfDirectory = path.join(root, 'not-a-directory')
      await writeFile(fileInsteadOfDirectory, 'fixture', 'utf8')
      expect(() =>
        DatabaseService.open({
          databasePath: path.join(fileInsteadOfDirectory, 'agent.db'),
          appVersion: 'test',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'DATABASE_IO',
          message: expect.stringContaining('I/O failed'),
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('indexes every child-side composite foreign key lookup', async () => {
    const testDatabase = await createTestDatabase()
    try {
      const queryPlans = testDatabase.database.read((reader) => ({
        sessionParent: reader
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id FROM sessions WHERE parent_session_id = ?`,
          )
          .all('session:parent'),
        replaySource: reader
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id FROM messages
             WHERE replayed_from_message_id = ? AND session_id = ?`,
          )
          .all('message:source', 'session:fixture'),
        derivationSource: reader
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id FROM messages
             WHERE derived_from_message_id = ? AND session_id = ?`,
          )
          .all('message:source', 'session:fixture'),
      }))

      expect(queryPlans.sessionParent).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining('sessions_parent_idx'),
        }),
      ])
      expect(queryPlans.replaySource).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining('messages_replayed_from_idx'),
        }),
      ])
      expect(queryPlans.derivationSource).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining('messages_derived_from_idx'),
        }),
      ])
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
      expect(count).toEqual({ count: 3 })
    } finally {
      await reopened.close()
      await testDatabase.dispose()
    }
  })

  it('backfills the FileChange workspace when migrating a v1 database', async () => {
    const legacy = await createTestDatabase({
      migrations: [DATABASE_MIGRATIONS[0]!],
    })
    const databasePath = legacy.databasePath
    const project = projectFixture({ path: 'C:/legacy-workspace' })
    const session = sessionFixture({ lastSeq: 0 })
    const record = fileChangeFixture({
      workspacePath: project.path,
      sessionId: session.id,
    })
    const row = encodeStoredFileChangeRow(record)
    await legacy.database.withTransaction((transaction) => {
      new ProjectRepository().insert(transaction, project)
      new SessionRepository().insert(transaction, session)
      transaction
        .prepare(
          `INSERT INTO file_changes (
             schema_version, id, session_id, assistant_message_id, call_id,
             path, operation, diff, diff_hash, diff_truncated, before_exists,
             before_hash, before_content, before_mode, after_exists, after_hash,
             payload_bytes, revision, created_at, updated_at, reverted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.schema_version,
          row.id,
          row.session_id,
          row.assistant_message_id,
          row.call_id,
          row.path,
          row.operation,
          row.diff,
          row.diff_hash,
          row.diff_truncated,
          row.before_exists,
          row.before_hash,
          row.before_content,
          row.before_mode,
          row.after_exists,
          row.after_hash,
          row.payload_bytes,
          row.revision,
          row.created_at,
          row.updated_at,
          row.reverted_at,
        )
    })
    await legacy.database.close()

    const migrated = DatabaseService.open({
      databasePath,
      appVersion: 'test-v2',
    })
    try {
      expect(
        migrated.read((reader) =>
          new FileChangeRepository().getStored(reader, session.id, record.id),
        ),
      ).toMatchObject({ workspacePath: project.path })
      expect(
        migrated.read((reader) =>
          reader
            .prepare(
              `SELECT total_payload_bytes
               FROM file_change_retention_state
               WHERE singleton = 1`,
            )
            .get(),
        ),
      ).toEqual({ total_payload_bytes: record.payloadBytes })
    } finally {
      await migrated.close()
      await legacy.dispose()
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
          DATABASE_MIGRATIONS[1]!,
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH' }),
    )
    await testDatabase.dispose()
  })

  it('rejects a database created by a newer migration set', async () => {
    const migrations: DatabaseMigration[] = [
      ...DATABASE_MIGRATIONS,
      {
        version: 4,
        name: '0004_future',
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
      ...DATABASE_MIGRATIONS,
      {
        version: 4,
        name: '0004_second',
        sql: 'CREATE TABLE second_step (id TEXT PRIMARY KEY) STRICT;',
      },
      {
        version: 5,
        name: '0005_third',
        sql: 'CREATE TABLE third_step (id TEXT PRIMARY KEY) STRICT;',
      },
    ]
    const testDatabase = await createTestDatabase({ migrations })
    const databasePath = testDatabase.databasePath
    await testDatabase.database.withTransaction((transaction) => {
      transaction
        .prepare('DELETE FROM schema_migrations WHERE version = ?')
        .run(4)
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
      ...DATABASE_MIGRATIONS,
      {
        version: 4,
        name: '0004_broken',
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
      ).toEqual({ count: 3 })
    } finally {
      raw.close()
      await first.dispose()
    }
  })

  it('serializes transactions and rolls back failed work', async () => {
    const testDatabase = await createTestDatabase({
      migrations: [
        ...DATABASE_MIGRATIONS,
        {
          version: 4,
          name: '0004_transaction_probe',
          sql: `
            CREATE TABLE transaction_probe (
              id INTEGER PRIMARY KEY
            ) STRICT;
          `,
        },
      ],
    })
    try {
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

  it('rejects nested transactions before they can escape outer atomicity', async () => {
    const testDatabase = await createTestDatabase()
    try {
      let nested: Promise<unknown> | undefined
      await testDatabase.database.withTransaction(() => {
        nested = testDatabase.database.withTransaction(() => 'nested')
      })
      await expect(nested).rejects.toMatchObject({
        code: 'NESTED_TRANSACTION_NOT_ALLOWED',
      })
    } finally {
      await testDatabase.dispose()
    }
  })

  it.each([
    'COMMIT',
    'END',
    'ROLLBACK',
    'BEGIN',
    'BEGIN IMMEDIATE',
    'SAVEPOINT nested',
    'RELEASE nested',
    'ROLLBACK TO nested',
  ])('rejects transaction control SQL from callbacks: %s', async (sql) => {
    const testDatabase = await createTestDatabase({
      migrations: [
        ...DATABASE_MIGRATIONS,
        {
          version: 4,
          name: '0004_transaction_control_probe',
          sql: 'CREATE TABLE transaction_control_probe (id INTEGER PRIMARY KEY) STRICT;',
        },
      ],
    })
    try {
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          transaction
            .prepare('INSERT INTO transaction_control_probe (id) VALUES (1)')
            .run()
          transaction.prepare(sql).run()
        }),
      ).rejects.toBeDefined()
      expect(
        testDatabase.database.read((reader) =>
          reader.prepare('SELECT id FROM transaction_control_probe').all(),
        ),
      ).toEqual([])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('reports bounded migration progress without trusting callbacks', async () => {
    const progress: Array<{
      version: number
      name: string
      stage: string
      elapsedMs: number
    }> = []
    const database = DatabaseService.open({
      databasePath: ':memory:',
      appVersion: 'test',
      migrations: [DATABASE_MIGRATIONS[0]!],
      onMigrationProgress(event) {
        progress.push(event)
        if (event.stage === 'started') throw new Error('diagnostic failure')
      },
    })
    try {
      expect(progress).toEqual([
        expect.objectContaining({
          version: 1,
          name: '0001_initial',
          stage: 'started',
          elapsedMs: 0,
        }),
        expect.objectContaining({
          version: 1,
          name: '0001_initial',
          stage: 'completed',
        }),
      ])
    } finally {
      await database.close()
    }
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
    expect(desktopDatabasePath('C:\\UserData')).toBe(
      path.join('C:\\UserData', 'agent.db'),
    )
    expect(headlessTrialDatabasePath('C:\\trial-42')).toBe(
      path.join('C:\\trial-42', 'agent.db'),
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
