import { Type, type Static } from '@sinclair/typebox'
import {
  DateTimeSchema,
  DurableSchemaVersionSchema,
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
