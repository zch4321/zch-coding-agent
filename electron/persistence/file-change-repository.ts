import { MAX_FILE_CHANGE_RECORDS } from '../../shared/durable'
import type { FileChangeId, SessionId } from '../../shared/ids'
import type { FileChangeSummary } from '../../shared/file-change'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import {
  decodeFileChangeSummaryRow,
  decodeStoredFileChangeRow,
  encodeStoredFileChangeRow,
  type StoredFileChangeRecord,
} from './file-change-codec'
import { PersistenceError } from './persistence-error'

const FILE_CHANGE_SUMMARY_COLUMNS = `
  schema_version, id, session_id, call_id, path, operation, diff, diff_hash,
  diff_truncated, before_exists, before_hash, after_exists, after_hash,
  revision, created_at, updated_at, reverted_at
`
const STORED_FILE_CHANGE_COLUMNS = `
  ${FILE_CHANGE_SUMMARY_COLUMNS}, before_content, payload_bytes
`

export const MAX_FILE_CHANGE_PAYLOAD_BYTES = 50_000_000

export interface FileChangeRepositoryOptions {
  maxRecords?: number
  maxPayloadBytes?: number
}

export class FileChangeRepository {
  readonly #maxRecords: number
  readonly #maxPayloadBytes: number

  constructor(options: FileChangeRepositoryOptions = {}) {
    this.#maxRecords = positiveLimit(
      options.maxRecords ?? MAX_FILE_CHANGE_RECORDS,
      'FileChange record limit',
    )
    this.#maxPayloadBytes = positiveLimit(
      options.maxPayloadBytes ?? MAX_FILE_CHANGE_PAYLOAD_BYTES,
      'FileChange payload limit',
    )
  }

  insertWithRetention(
    transaction: PersistenceTransaction,
    record: StoredFileChangeRecord,
  ): void {
    assertFileChangePayloadWithinLimit(
      record.payloadBytes,
      this.#maxPayloadBytes,
    )
    const row = encodeStoredFileChangeRow(record)
    const existing = transaction
      .prepare(
        `SELECT id, payload_bytes
         FROM file_changes
         ORDER BY created_at ASC, id ASC`,
      )
      .all()
      .map((candidate) => ({
        id: String(candidate.id),
        payloadBytes: Number(candidate.payload_bytes),
      }))
    let totalBytes = existing.reduce(
      (total, candidate) => total + candidate.payloadBytes,
      0,
    )
    let retainedCount = existing.length
    const remove = transaction.prepare('DELETE FROM file_changes WHERE id = ?')

    for (const candidate of existing) {
      if (
        retainedCount + 1 <= this.#maxRecords &&
        totalBytes + row.payload_bytes <= this.#maxPayloadBytes
      ) {
        break
      }
      remove.run(candidate.id)
      retainedCount -= 1
      totalBytes -= candidate.payloadBytes
    }

    transaction
      .prepare(
        `INSERT INTO file_changes (
           schema_version, id, session_id, call_id, path, operation, diff,
           diff_hash, diff_truncated, before_exists, before_hash,
           before_content, after_exists, after_hash, payload_bytes, revision,
           created_at, updated_at, reverted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.schema_version,
        row.id,
        row.session_id,
        row.call_id,
        row.path,
        row.operation,
        row.diff,
        row.diff_hash,
        row.diff_truncated,
        row.before_exists,
        row.before_hash,
        row.before_content,
        row.after_exists,
        row.after_hash,
        row.payload_bytes,
        row.revision,
        row.created_at,
        row.updated_at,
        row.reverted_at,
      )
  }

  update(
    transaction: PersistenceTransaction,
    record: StoredFileChangeRecord,
    expectedRevision: number,
  ): boolean {
    assertFileChangePayloadWithinLimit(
      record.payloadBytes,
      this.#maxPayloadBytes,
    )
    const row = encodeStoredFileChangeRow(record)
    assertRevisionTransition(expectedRevision, row.revision)
    const result = transaction
      .prepare(
        `UPDATE file_changes
         SET diff = ?, diff_hash = ?, diff_truncated = ?, before_exists = ?,
             before_hash = ?, before_content = ?, after_exists = ?,
             after_hash = ?, payload_bytes = ?, revision = ?, updated_at = ?,
             reverted_at = ?
         WHERE id = ? AND session_id = ? AND revision = ?`,
      )
      .run(
        row.diff,
        row.diff_hash,
        row.diff_truncated,
        row.before_exists,
        row.before_hash,
        row.before_content,
        row.after_exists,
        row.after_hash,
        row.payload_bytes,
        row.revision,
        row.updated_at,
        row.reverted_at,
        row.id,
        row.session_id,
        expectedRevision,
      )
    return Number(result.changes) > 0
  }

  getStored(
    reader: PersistenceReader,
    sessionId: SessionId,
    id: FileChangeId,
  ): StoredFileChangeRecord | undefined {
    const row = reader
      .prepare(
        `SELECT ${STORED_FILE_CHANGE_COLUMNS}
         FROM file_changes
         WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, id)
    return row ? decodeStoredFileChangeRow(row) : undefined
  }

  listSummaries(
    reader: PersistenceReader,
    sessionId: SessionId,
  ): FileChangeSummary[] {
    return reader
      .prepare(
        `SELECT ${FILE_CHANGE_SUMMARY_COLUMNS}
         FROM file_changes
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, this.#maxRecords)
      .map(decodeFileChangeSummaryRow)
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
      'FileChange update revision must increment by exactly one',
    )
  }
}

export function assertFileChangePayloadWithinLimit(
  payloadBytes: number,
  maximum = MAX_FILE_CHANGE_PAYLOAD_BYTES,
): void {
  if (
    Number.isSafeInteger(payloadBytes) &&
    payloadBytes >= 0 &&
    payloadBytes <= maximum
  ) {
    return
  }
  throw new PersistenceError(
    'FILE_CHANGE_LIMIT_EXCEEDED',
    `FileChange payload ${payloadBytes} exceeds limit ${maximum}`,
  )
}

function positiveLimit(value: number, label: string): number {
  if (Number.isSafeInteger(value) && value >= 1) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be a positive safe integer`,
  )
}
