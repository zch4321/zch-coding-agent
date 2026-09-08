import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  PersistenceError,
  normalizePersistenceError,
} from './persistence-error'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

/** Holds exclusive backend ownership in the same database, independently of business migrations. */
export class ProfileOwnership {
  readonly #database: DatabaseSync
  readonly #token = randomUUID()
  #released = false

  private constructor(readonly databasePath: string) {
    try {
      this.#database = new DatabaseSync(databasePath, {
        timeout: 5_000,
        allowExtension: false,
      })
    } catch (error) {
      throw normalizePersistenceError(error)
    }
    try {
      this.#database.exec('BEGIN IMMEDIATE')
      this.#database.exec(`CREATE TABLE IF NOT EXISTS backend_profile_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pid INTEGER NOT NULL CHECK (pid > 0), token TEXT NOT NULL
      ) STRICT`)
      const owner = this.#database
        .prepare(
          'SELECT pid, token FROM backend_profile_owner WHERE singleton = 1',
        )
        .get()
      // A reused or inaccessible live PID remains busy; never evict a potentially live owner.
      if (owner && processExists(Number(owner.pid))) {
        throw new PersistenceError(
          'PROFILE_IN_USE',
          'PROFILE_IN_USE: This profile is already in use. Close its Desktop or Headless process, or select another profile.',
        )
      }
      this.#database
        .prepare(
          `INSERT INTO backend_profile_owner(singleton, pid, token)
        VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET pid = excluded.pid, token = excluded.token`,
        )
        .run(process.pid, this.#token)
      this.#database.exec('COMMIT')
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      this.#database.close()
      throw normalizePersistenceError(error)
    }
  }

  /** Atomically claims a profile before opening business services or running recovery. */
  static acquire(databasePath: string): ProfileOwnership {
    return new ProfileOwnership(databasePath)
  }

  /** Checks a caller-supplied lease without allowing it to authorize a different database. */
  assertOwned(databasePath: string): void {
    if (this.#released || this.databasePath !== databasePath) {
      throw new PersistenceError(
        'PROFILE_IN_USE',
        'Profile ownership does not match this database',
      )
    }
  }

  /** Releases only this owner's token after its backend has fully stopped. */
  release(): void {
    if (this.#released) return
    this.#released = true
    try {
      this.#database
        .prepare(
          'DELETE FROM backend_profile_owner WHERE singleton = 1 AND token = ?',
        )
        .run(this.#token)
    } finally {
      this.#database.close()
    }
  }
}
