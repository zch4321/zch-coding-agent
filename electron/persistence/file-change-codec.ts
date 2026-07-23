import { Buffer } from 'node:buffer'
import {
  assertFileChangeSummarySemantics,
  FileChangeSummarySchema,
  type FileChangeSummary,
} from '../../shared/file-change'
import type { CallId, FileChangeId, SessionId } from '../../shared/ids'
import { compileSchema } from '../schema-validator'
import {
  assertSchemaValue,
  booleanColumn,
  integerColumn,
  nullableStringColumn,
  stringColumn,
} from './codec-helpers'
import { PersistenceError } from './persistence-error'

const validateFileChangeSummary = compileSchema(FileChangeSummarySchema)

export interface StoredFileChangeRecord extends FileChangeSummary {
  beforeContent: string | null
  payloadBytes: number
}

export interface FileChangeSummaryRow {
  schema_version: number
  id: string
  session_id: string
  call_id: string
  path: string
  operation: string
  diff: string
  diff_hash: string
  diff_truncated: number
  before_exists: number
  before_hash: string
  after_exists: number
  after_hash: string
  revision: number
  created_at: string
  updated_at: string
  reverted_at: string | null
}

export interface StoredFileChangeRow extends FileChangeSummaryRow {
  before_content: string | null
  payload_bytes: number
}

export function encodeStoredFileChangeRow(
  record: StoredFileChangeRecord,
): StoredFileChangeRow {
  assertStoredFileChangeRecord(record)
  return {
    schema_version: record.schemaVersion,
    id: record.id,
    session_id: record.sessionId,
    call_id: record.callId,
    path: record.path,
    operation: record.operation,
    diff: record.diff,
    diff_hash: record.diffHash,
    diff_truncated: record.diffTruncated ? 1 : 0,
    before_exists: record.beforeExists ? 1 : 0,
    before_hash: record.beforeHash,
    before_content: record.beforeContent,
    after_exists: record.afterExists ? 1 : 0,
    after_hash: record.afterHash,
    payload_bytes: record.payloadBytes,
    revision: record.revision,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    reverted_at: record.revertedAt ?? null,
  }
}

export function decodeStoredFileChangeRow(
  row: Record<string, unknown>,
): StoredFileChangeRecord {
  const record = {
    ...decodeFileChangeSummaryRow(row),
    beforeContent: nullableStringColumn(
      row.before_content,
      'file_changes.before_content',
    ),
    payloadBytes: integerColumn(
      row.payload_bytes,
      'file_changes.payload_bytes',
    ),
  }
  assertStoredFileChangeRecord(record)
  return record
}

export function decodeFileChangeSummaryRow(
  row: Record<string, unknown>,
): FileChangeSummary {
  const revertedAt = nullableStringColumn(
    row.reverted_at,
    'file_changes.reverted_at',
  )
  const summary = {
    schemaVersion: integerColumn(
      row.schema_version,
      'file_changes.schema_version',
    ),
    id: stringColumn(row.id, 'file_changes.id') as FileChangeId,
    sessionId: stringColumn(
      row.session_id,
      'file_changes.session_id',
    ) as SessionId,
    callId: stringColumn(row.call_id, 'file_changes.call_id') as CallId,
    path: stringColumn(row.path, 'file_changes.path'),
    operation: stringColumn(row.operation, 'file_changes.operation'),
    diff: stringColumn(row.diff, 'file_changes.diff'),
    diffHash: stringColumn(row.diff_hash, 'file_changes.diff_hash'),
    diffTruncated: booleanColumn(
      row.diff_truncated,
      'file_changes.diff_truncated',
    ),
    beforeExists: booleanColumn(
      row.before_exists,
      'file_changes.before_exists',
    ),
    beforeHash: stringColumn(row.before_hash, 'file_changes.before_hash'),
    afterExists: booleanColumn(row.after_exists, 'file_changes.after_exists'),
    afterHash: stringColumn(row.after_hash, 'file_changes.after_hash'),
    revision: integerColumn(row.revision, 'file_changes.revision'),
    createdAt: stringColumn(row.created_at, 'file_changes.created_at'),
    updatedAt: stringColumn(row.updated_at, 'file_changes.updated_at'),
    ...(revertedAt === null ? {} : { revertedAt }),
  }
  assertSchemaValue<FileChangeSummary>(
    validateFileChangeSummary,
    summary,
    'FileChangeSummary row',
  )
  assertFileChangeSummarySemantics(summary)
  return summary
}

export function toFileChangeSummary(
  record: StoredFileChangeRecord,
): FileChangeSummary {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    sessionId: record.sessionId,
    callId: record.callId,
    path: record.path,
    operation: record.operation,
    diff: record.diff,
    diffHash: record.diffHash,
    diffTruncated: record.diffTruncated,
    beforeExists: record.beforeExists,
    beforeHash: record.beforeHash,
    afterExists: record.afterExists,
    afterHash: record.afterHash,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.revertedAt ? { revertedAt: record.revertedAt } : {}),
  }
}

function assertStoredFileChangeRecord(record: StoredFileChangeRecord): void {
  const summary = toFileChangeSummary(record)
  assertSchemaValue<FileChangeSummary>(
    validateFileChangeSummary,
    summary,
    'StoredFileChangeRecord summary',
  )
  assertFileChangeSummarySemantics(summary)
  if (!Number.isSafeInteger(record.payloadBytes) || record.payloadBytes < 0) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'StoredFileChangeRecord payloadBytes must be a non-negative safe integer',
    )
  }
  if (record.beforeExists !== (record.beforeContent !== null)) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'StoredFileChangeRecord beforeContent does not match beforeExists',
    )
  }
  const expectedBytes =
    Buffer.byteLength(record.diff, 'utf8') +
    Buffer.byteLength(record.beforeContent ?? '', 'utf8')
  if (record.payloadBytes !== expectedBytes) {
    throw new PersistenceError(
      'CODEC_INVALID',
      `StoredFileChangeRecord payloadBytes must equal ${expectedBytes}`,
    )
  }
}
