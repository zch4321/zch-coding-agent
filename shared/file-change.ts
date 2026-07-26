import { Type, type Static } from '@sinclair/typebox'
import {
  DateTimeSchema,
  DurableSchemaVersionSchema,
  MAX_FILE_CHANGE_PAGE_RECORDS,
  MAX_PATH_LENGTH,
  RevisionSchema,
  Sha256Schema,
} from './durable'
import { CallIdSchema, FileChangeIdSchema, SessionIdSchema } from './ids'

export const FileChangeOperationSchema = Type.Union([
  Type.Literal('write'),
  Type.Literal('patch'),
  Type.Literal('delete'),
])
export type FileChangeOperation = Static<typeof FileChangeOperationSchema>

export const FileChangeSummarySchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    id: FileChangeIdSchema,
    sessionId: SessionIdSchema,
    callId: CallIdSchema,
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }),
    operation: FileChangeOperationSchema,
    diff: Type.String({ maxLength: 262_144 }),
    diffHash: Sha256Schema,
    diffTruncated: Type.Boolean(),
    beforeExists: Type.Boolean(),
    beforeHash: Sha256Schema,
    afterExists: Type.Boolean(),
    afterHash: Sha256Schema,
    revision: RevisionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    revertedAt: Type.Optional(DateTimeSchema),
  },
  { additionalProperties: false },
)
export type FileChangeSummary = Static<typeof FileChangeSummarySchema>

export const FileChangeListCursorSchema = Type.Object(
  {
    createdAt: DateTimeSchema,
    fileChangeId: FileChangeIdSchema,
  },
  { additionalProperties: false },
)
export type FileChangeListCursor = Static<typeof FileChangeListCursorSchema>

const fileChangePageProperties = {
  schemaVersion: DurableSchemaVersionSchema,
  sessionId: SessionIdSchema,
}

export const FileChangePageSchema = Type.Union([
  Type.Object(
    {
      ...fileChangePageProperties,
      records: Type.Array(FileChangeSummarySchema, {
        minItems: 1,
        maxItems: MAX_FILE_CHANGE_PAGE_RECORDS,
      }),
      hasMore: Type.Literal(true),
      nextBefore: FileChangeListCursorSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...fileChangePageProperties,
      records: Type.Array(FileChangeSummarySchema, {
        maxItems: MAX_FILE_CHANGE_PAGE_RECORDS,
      }),
      hasMore: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
])
export type FileChangePage = Static<typeof FileChangePageSchema>

/** Validates session identity, ordering, and pagination invariants for a FileChange page. */
export function assertFileChangePageSemantics(page: FileChangePage): void {
  for (const record of page.records) {
    if (record.sessionId !== page.sessionId) {
      throw new TypeError('FileChange page contains a different Session')
    }
  }
  if (page.hasMore) {
    const last = page.records.at(-1)
    if (
      !last ||
      page.nextBefore.createdAt !== last.createdAt ||
      page.nextBefore.fileChangeId !== last.id
    ) {
      throw new TypeError(
        'FileChange next cursor must identify the final page record',
      )
    }
  }
}

export const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Validates before/after existence and hash metadata for one FileChange summary. */
export function assertFileChangeSummarySemantics(
  record: FileChangeSummary,
): void {
  if (!record.beforeExists && record.beforeHash !== EMPTY_FILE_SHA256) {
    throw new TypeError(
      'A missing before-state must use the empty-content SHA-256',
    )
  }
  if (!record.afterExists && record.afterHash !== EMPTY_FILE_SHA256) {
    throw new TypeError(
      'A missing after-state must use the empty-content SHA-256',
    )
  }
}
