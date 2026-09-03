import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync, constants, type StatementSync } from 'node:sqlite'
import { DATABASE_MIGRATIONS, type DatabaseMigration } from './migrations'
import {
  normalizePersistenceError,
  PersistenceError,
} from './persistence-error'

const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version          INTEGER PRIMARY KEY CHECK (version > 0),
  name             TEXT NOT NULL UNIQUE,
  checksum_sha256  TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  app_version      TEXT NOT NULL,
  applied_at       TEXT NOT NULL
) STRICT;
`

interface AppliedMigrationRow {
  version: number
  name: string
  checksum_sha256: string
}

export interface DatabaseServiceOptions {
  databasePath: string
  appVersion: string
  migrations?: readonly DatabaseMigration[]
  now?: () => string
  onMigrationProgress?: (progress: DatabaseMigrationProgress) => void
}

export interface DatabaseMigrationProgress {
  version: number
  name: string
  stage: 'started' | 'completed' | 'failed'
  elapsedMs: number
}

/**
 * Provides prepared statements to repository query callbacks.
 *
 * SQLite does not enforce this facade as read-only. Callers must not execute
 * mutating SQL through a PersistenceReader; durable writes belong in
 * DatabaseService.withTransaction callbacks using PersistenceTransaction.
 */
export class PersistenceReader {
  constructor(protected readonly database: DatabaseSync) {}

  /** Prepares a SQL statement and normalizes driver errors into PersistenceError. */
  prepare(sql: string): StatementSync {
    try {
      return wrapStatement(this.database.prepare(sql))
    } catch (error) {
      throw normalizePersistenceError(error)
    }
  }
}

/** Restricts prepared statements to an active write transaction. */
export class PersistenceTransaction extends PersistenceReader {
  #active = true

  /** Prepares a statement only while this transaction is active. */
  override prepare(sql: string): StatementSync {
    this.#assertActive()
    return super.prepare(sql)
  }

  /** Marks the transaction inactive so no further statements can be prepared. */
  deactivate(): void {
    this.#active = false
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new PersistenceError(
        'DATABASE_CLOSED',
        'Persistence transaction is no longer active',
      )
    }
  }
}

/** Owns SQLite configuration, migrations, serialized writes, and orderly shutdown. */
export class DatabaseService {
  readonly databasePath: string
  readonly #database: DatabaseSync
  readonly #reader: PersistenceReader
  #writeTail: Promise<void> = Promise.resolve()
  #acceptingWork = true
  #closePromise?: Promise<void>

  private constructor(options: DatabaseServiceOptions) {
    this.databasePath = options.databasePath
    try {
      this.#database = new DatabaseSync(options.databasePath, {
        allowExtension: false,
        defensive: true,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      })
    } catch (error) {
      throw normalizePersistenceError(error)
    }
    this.#reader = new PersistenceReader(this.#database)

    try {
      this.#configure()
      this.#migrate(
        options.migrations ?? DATABASE_MIGRATIONS,
        options.appVersion,
        options.now ?? (() => new Date().toISOString()),
        options.onMigrationProgress,
      )
    } catch (error) {
      this.#database.close()
      throw normalizePersistenceError(error)
    }
  }

  /** Opens a configured SQLite database and applies its validated migrations. */
  static open(options: DatabaseServiceOptions): DatabaseService {
    return new DatabaseService(options)
  }

  /** Runs a synchronous query callback under the PersistenceReader no-write contract. */
  read<Result>(work: (reader: PersistenceReader) => Result): Result {
    this.#assertOpen()
    return work(this.#reader)
  }

  /** Queues a synchronous transaction, rejecting nested or asynchronous transaction work. */
  withTransaction<Result>(
    work: (transaction: PersistenceTransaction) => Result,
  ): Promise<Result> {
    if (!this.#acceptingWork) {
      return Promise.reject(
        new PersistenceError('DATABASE_CLOSED', 'Database is closed'),
      )
    }
    if (this.#database.isTransaction) {
      return Promise.reject(
        new PersistenceError(
          'NESTED_TRANSACTION_NOT_ALLOWED',
          'Persistence transactions cannot be nested',
        ),
      )
    }
    return this.#enqueueWrite(() => {
      try {
        this.#database.exec('BEGIN IMMEDIATE')
      } catch (error) {
        throw normalizePersistenceError(error)
      }
      const transaction = new PersistenceTransaction(this.#database)

      try {
        this.#database.setAuthorizer((actionCode) =>
          actionCode === constants.SQLITE_TRANSACTION ||
          actionCode === constants.SQLITE_SAVEPOINT
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        )
        const result = work(transaction)
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined)
          throw new PersistenceError(
            'ASYNC_TRANSACTION_NOT_ALLOWED',
            'Persistence transactions must not await external work',
          )
        }
        transaction.deactivate()
        this.#database.setAuthorizer(null)
        this.#database.exec('COMMIT')
        return result
      } catch (error) {
        transaction.deactivate()
        this.#database.setAuthorizer(null)
        if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
        throw normalizePersistenceError(error)
      }
    })
  }

  /** Stops accepting work and closes SQLite after all queued writes settle. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#acceptingWork = false
    this.#closePromise = this.#writeTail.then(() => {
      if (this.#database.isOpen) this.#database.close()
    })
    return this.#closePromise
  }

  #configure(): void {
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA busy_timeout = 5000')
  }

  #migrate(
    migrations: readonly DatabaseMigration[],
    appVersion: string,
    now: () => string,
    onProgress?: (progress: DatabaseMigrationProgress) => void,
  ): void {
    validateMigrations(migrations)
    this.#database.exec(SCHEMA_MIGRATIONS_SQL)

    const applied = this.#database
      .prepare(
        `SELECT version, name, checksum_sha256
         FROM schema_migrations
         ORDER BY version ASC`,
      )
      .all() as unknown as AppliedMigrationRow[]
    const supportedByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    )
    const latestSupported = migrations.at(-1)?.version ?? 0

    for (const [index, row] of applied.entries()) {
      if (row.version > latestSupported) {
        throw new PersistenceError(
          'DATABASE_VERSION_TOO_NEW',
          `Database schema version ${row.version} is newer than supported version ${latestSupported}`,
        )
      }
      if (row.version !== index + 1) {
        throw new PersistenceError(
          'MIGRATION_INVALID',
          `Applied migrations are not contiguous at version ${index + 1}`,
        )
      }
      const migration = supportedByVersion.get(row.version)
      const appliedSql = migration
        ? appliedMigrationSql(migration, row.name)
        : undefined
      if (!migration || appliedSql === undefined) {
        throw new PersistenceError(
          'MIGRATION_INVALID',
          `Applied migration ${row.version}:${row.name} is not supported`,
        )
      }
      const checksum = migrationChecksum(appliedSql)
      if (row.checksum_sha256 !== checksum) {
        throw new PersistenceError(
          'MIGRATION_CHECKSUM_MISMATCH',
          `Migration ${row.name} checksum does not match the applied database`,
        )
      }
    }

    const appliedVersions = new Set(applied.map((row) => row.version))
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue
      this.#applyMigration(migration, appVersion, now(), onProgress)
    }
  }

  #applyMigration(
    migration: DatabaseMigration,
    appVersion: string,
    appliedAt: string,
    onProgress?: (progress: DatabaseMigrationProgress) => void,
  ): void {
    const startedAt = performance.now()
    emitMigrationProgress(onProgress, {
      version: migration.version,
      name: migration.name,
      stage: 'started',
      elapsedMs: 0,
    })
    const pauseForeignKeys = migration.disableForeignKeys === true
    if (pauseForeignKeys) this.#database.exec('PRAGMA foreign_keys = OFF')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.exec(migration.sql)
      if (pauseForeignKeys) this.#assertNoForeignKeyViolations(migration)
      this.#database
        .prepare(
          `INSERT INTO schema_migrations (
             version, name, checksum_sha256, app_version, applied_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migrationChecksum(migration.sql),
          appVersion,
          appliedAt,
        )
      this.#database.exec('COMMIT')
      emitMigrationProgress(onProgress, {
        version: migration.version,
        name: migration.name,
        stage: 'completed',
        elapsedMs: Math.max(0, performance.now() - startedAt),
      })
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      emitMigrationProgress(onProgress, {
        version: migration.version,
        name: migration.name,
        stage: 'failed',
        elapsedMs: Math.max(0, performance.now() - startedAt),
      })
      throw new PersistenceError(
        'MIGRATION_FAILED',
        `Migration ${migration.name} failed`,
        { cause: error },
      )
    } finally {
      if (pauseForeignKeys) this.#database.exec('PRAGMA foreign_keys = ON')
    }
  }

  /** Fails a table-rebuild migration when it leaves any foreign key violation. */
  #assertNoForeignKeyViolations(migration: DatabaseMigration): void {
    const violations = this.#database.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) {
      throw new PersistenceError(
        'MIGRATION_FAILED',
        `Migration ${migration.name} left ${violations.length} foreign key violations`,
      )
    }
  }

  #enqueueWrite<Result>(work: () => Result): Promise<Result> {
    if (!this.#acceptingWork) {
      return Promise.reject(
        new PersistenceError('DATABASE_CLOSED', 'Database is closed'),
      )
    }

    const result = this.#writeTail.then(work)
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #assertOpen(): void {
    if (!this.#acceptingWork || !this.#database.isOpen) {
      throw new PersistenceError('DATABASE_CLOSED', 'Database is closed')
    }
  }
}

function emitMigrationProgress(
  listener: DatabaseServiceOptions['onMigrationProgress'],
  progress: DatabaseMigrationProgress,
): void {
  try {
    listener?.(progress)
  } catch {
    // Diagnostic callbacks must never change migration correctness.
  }
}

function wrapStatement(statement: StatementSync): StatementSync {
  return new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        try {
          return Reflect.apply(value, target, args)
        } catch (error) {
          throw normalizePersistenceError(error)
        }
      }
    },
  })
}

/** Returns the default SQLite path used by the desktop application. */
export function desktopDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, 'agent.db')
}

/** Returns the isolated SQLite path used by one headless run. */
export function headlessDatabasePath(runDirectory: string): string {
  return path.join(runDirectory, 'agent.db')
}

/** Computes the SHA-256 checksum used to identify migration SQL content. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function validateMigrations(migrations: readonly DatabaseMigration[]): void {
  const names = new Set<string>()
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1
    const expectedNamePrefix = `${String(expectedVersion).padStart(4, '0')}_`
    if (
      migration.version !== expectedVersion ||
      !/^\d{4}_[a-z0-9_]+$/u.test(migration.name) ||
      !migration.name.startsWith(expectedNamePrefix) ||
      migration.sql.trim().length === 0 ||
      names.has(migration.name)
    ) {
      throw new PersistenceError(
        'MIGRATION_INVALID',
        `Migration ${migration.name || '<unnamed>'} is not a valid version ${expectedVersion}`,
      )
    }
    names.add(migration.name)
    for (const variant of migration.acceptedAppliedVariants ?? []) {
      if (
        !/^\d{4}_[a-z0-9_]+$/u.test(variant.name) ||
        !variant.name.startsWith(expectedNamePrefix) ||
        variant.sql.trim().length === 0 ||
        names.has(variant.name)
      ) {
        throw new PersistenceError(
          'MIGRATION_INVALID',
          `Applied migration variant ${variant.name || '<unnamed>'} is not valid for version ${expectedVersion}`,
        )
      }
      names.add(variant.name)
    }
  }
}

function appliedMigrationSql(
  migration: DatabaseMigration,
  appliedName: string,
): string | undefined {
  if (migration.name === appliedName) return migration.sql
  return migration.acceptedAppliedVariants?.find(
    (variant) => variant.name === appliedName,
  )?.sql
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
