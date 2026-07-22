export type PersistenceErrorCode =
  | 'DATABASE_CLOSED'
  | 'DATABASE_VERSION_TOO_NEW'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_INVALID'
  | 'MIGRATION_FAILED'
  | 'ASYNC_TRANSACTION_NOT_ALLOWED'
  | 'CODEC_INVALID'
  | 'FILE_CHANGE_LIMIT_EXCEEDED'

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode
  readonly cause?: unknown

  constructor(
    code: PersistenceErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'PersistenceError'
    this.code = code
    this.cause = options.cause
  }
}
