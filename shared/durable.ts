import { Type } from '@sinclair/typebox'

export const DURABLE_SCHEMA_VERSION = 1 as const

export const MAX_PROJECT_RECORDS = 512
export const MAX_BOOTSTRAP_SESSION_RECORDS = 200
export const MAX_SESSION_LIST_RECORDS = 200
export const MAX_MESSAGE_PAGE_RECORDS = 200
export const MAX_COMMIT_MESSAGE_RECORDS = 512
export const MAX_FORK_MESSAGE_RECORDS = 512
export const MAX_FILE_CHANGE_RECORDS = 200
export const MAX_MESSAGE_PARTS = 256
export const MAX_MESSAGE_TEXT_LENGTH = 1_000_000
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128
export const MAX_PATH_LENGTH = 4_096
export const MAX_RUNTIME_TEXT_LENGTH = 1_000_000
export const MAX_RUNTIME_TOOL_RECORDS = 256
export const MAX_RUNTIME_INTERJECTIONS = 64

export const DurableSchemaVersionSchema = Type.Literal(DURABLE_SCHEMA_VERSION)
export const RevisionSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
})
export const MessageSeqSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
})
export const LastMessageSeqSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
})
export const BackendEventSequenceSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
})
export const DateTimeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  format: 'date-time',
})
export const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
})
export const ClientRequestIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_CLIENT_REQUEST_ID_LENGTH,
})
