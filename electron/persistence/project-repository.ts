import type { ProjectId } from '../../shared/ids'
import type { ProjectRecord } from '../../shared/project'
import { MAX_PROJECT_RECORDS } from '../../shared/durable'
import { decodeProjectRow, encodeProjectRow } from './project-codec'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import { PersistenceError } from './persistence-error'

const PROJECT_COLUMNS = `
  schema_version, id, path, name, revision, created_at, updated_at
`

/** Persists and queries project records. */
export class ProjectRepository {
  /** Returns the complete number of durable Project records. */
  count(reader: PersistenceReader): number {
    const row = reader.prepare('SELECT COUNT(*) AS total FROM projects').get()
    const total = Number(row?.total)
    if (Number.isSafeInteger(total) && total >= 0) return total
    throw new PersistenceError(
      'CODEC_INVALID',
      'Project count must be a non-negative safe integer',
    )
  }

  /** Returns or updates insert state. */
  insert(transaction: PersistenceTransaction, record: ProjectRecord): void {
    const row = encodeProjectRow(record)
    transaction
      .prepare(
        `INSERT INTO projects (
           schema_version, id, path, name, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.schema_version,
        row.id,
        row.path,
        row.name,
        row.revision,
        row.created_at,
        row.updated_at,
      )
  }

  /** Updates the requested record. */
  update(
    transaction: PersistenceTransaction,
    record: ProjectRecord,
    expectedRevision: number,
  ): boolean {
    const row = encodeProjectRow(record)
    assertRevisionTransition(expectedRevision, row.revision)
    const result = transaction
      .prepare(
        `UPDATE projects
         SET path = ?, name = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        row.path,
        row.name,
        row.revision,
        row.updated_at,
        row.id,
        expectedRevision,
      )
    return Number(result.changes) > 0
  }

  /** Deletes the requested record. */
  delete(transaction: PersistenceTransaction, id: ProjectId): boolean {
    const result = transaction
      .prepare('DELETE FROM projects WHERE id = ?')
      .run(id)
    return Number(result.changes) > 0
  }

  /** Returns the requested record. */
  get(reader: PersistenceReader, id: ProjectId): ProjectRecord | undefined {
    const row = reader
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .get(id)
    return row ? decodeProjectRow(row) : undefined
  }

  /** Lists the currently available records. */
  list(reader: PersistenceReader): ProjectRecord[] {
    return reader
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(MAX_PROJECT_RECORDS)
      .map(decodeProjectRow)
  }
}

function assertRevisionTransition(expected: number, next: number): void {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    next !== expected + 1
  ) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Project update revision must increment by exactly one',
    )
  }
}
