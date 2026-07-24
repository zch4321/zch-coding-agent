import { MAX_FILE_CHANGE_PAGE_RECORDS } from '../../shared/durable'
import type { FileChangeId, SessionId } from '../../shared/ids'
import {
  assertFileChangePageSemantics,
  type FileChangeListCursor,
  type FileChangePage,
} from '../../shared/file-change'
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
import { dateTimeColumn } from './codec-helpers'
import { PersistenceError } from './persistence-error'

const FILE_CHANGE_SUMMARY_COLUMNS = `
  schema_version, id, session_id, call_id, path, operation, diff, diff_hash,
  diff_truncated, before_exists, before_hash, after_exists, after_hash,
  revision, created_at, updated_at, reverted_at
`
const STORED_FILE_CHANGE_COLUMNS = `
  ${FILE_CHANGE_SUMMARY_COLUMNS}, before_content, payload_bytes
`

export const DEFAULT_FILE_CHANGE_HISTORY_BYTES = 100_000_000

export interface FileChangeRepositoryOptions {
  maxPayloadBytes?: number
}

export class FileChangeRepository {
  readonly #maxPayloadBytes: number

  constructor(options: FileChangeRepositoryOptions = {}) {
    this.#maxPayloadBytes = positiveLimit(
      options.maxPayloadBytes ?? DEFAULT_FILE_CHANGE_HISTORY_BYTES,
      'FileChange payload limit',
    )
  }

  insertWithRetention(
    transaction: PersistenceTransaction,
    record: StoredFileChangeRecord,
    maximumPayloadBytes = this.#maxPayloadBytes,
  ): { retentionApplied: boolean } {
    const maximum = positiveLimit(
      maximumPayloadBytes,
      'FileChange payload limit',
    )
    assertFileChangePayloadWithinLimit(record.payloadBytes, maximum)
    const row = encodeStoredFileChangeRow(record)
    const aggregate = transaction
      .prepare(
        `SELECT COALESCE(SUM(payload_bytes), 0) AS total_bytes
         FROM file_changes`,
      )
      .get()
    let overflow =
      Number(aggregate?.total_bytes ?? 0) + row.payload_bytes - maximum
    const remove = transaction.prepare('DELETE FROM file_changes WHERE id = ?')
    let retentionApplied = false

    while (overflow > 0) {
      const candidates = transaction
        .prepare(
          `SELECT id, payload_bytes
           FROM file_changes
           ORDER BY created_at ASC, id ASC
           LIMIT 256`,
        )
        .all()
      if (candidates.length === 0) break
      for (const candidate of candidates) {
        remove.run(String(candidate.id))
        overflow -= Number(candidate.payload_bytes)
        retentionApplied = true
        if (overflow <= 0) break
      }
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
    return { retentionApplied }
  }

  markReverted(
    transaction: PersistenceTransaction,
    input: {
      sessionId: SessionId
      id: FileChangeId
      revertedAt: string
      updatedAt: string
      revision: number
    },
    expectedRevision: number,
  ): boolean {
    assertRevisionTransition(expectedRevision, input.revision)
    const result = transaction
      .prepare(
        `UPDATE file_changes
         SET revision = ?, updated_at = ?, reverted_at = ?
         WHERE id = ? AND session_id = ? AND revision = ?`,
      )
      .run(
        input.revision,
        input.updatedAt,
        input.revertedAt,
        input.id,
        input.sessionId,
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

  listPage(
    reader: PersistenceReader,
    sessionId: SessionId,
    query: { before?: FileChangeListCursor; limit?: number } = {},
  ): FileChangePage {
    const limit = boundedLimit(
      query.limit ?? MAX_FILE_CHANGE_PAGE_RECORDS,
      MAX_FILE_CHANGE_PAGE_RECORDS,
      'FileChange page limit',
    )
    const parameters: Array<string | number> = [sessionId]
    let cursorClause = ''
    if (query.before) {
      const createdAt = dateTimeColumn(
        query.before.createdAt,
        'FileChange cursor createdAt',
      )
      cursorClause = 'AND (created_at < ? OR (created_at = ? AND id < ?))'
      parameters.push(createdAt, createdAt, query.before.fileChangeId)
    }
    const rows = reader
      .prepare(
        `SELECT ${FILE_CHANGE_SUMMARY_COLUMNS}
         FROM file_changes
         WHERE session_id = ?
         ${cursorClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit + 1)
    const hasMore = rows.length > limit
    const records = rows.slice(0, limit).map(decodeFileChangeSummaryRow)
    const page: FileChangePage = hasMore
      ? {
          schemaVersion: 1,
          sessionId,
          records,
          hasMore: true,
          nextBefore: {
            createdAt: records.at(-1)!.createdAt,
            fileChangeId: records.at(-1)!.id,
          },
        }
      : {
          schemaVersion: 1,
          sessionId,
          records,
          hasMore: false,
        }
    assertFileChangePageSemantics(page)
    return page
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
  maximum = DEFAULT_FILE_CHANGE_HISTORY_BYTES,
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

function boundedLimit(value: number, maximum: number, label: string): number {
  if (Number.isInteger(value) && value >= 1 && value <= maximum) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be between 1 and ${maximum}`,
  )
}

function positiveLimit(value: number, label: string): number {
  if (Number.isSafeInteger(value) && value >= 1) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be a positive safe integer`,
  )
}
