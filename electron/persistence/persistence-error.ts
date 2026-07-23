export type PersistenceErrorCode =
  | 'DATABASE_CLOSED'
  | 'DATABASE_BUSY'
  | 'DATABASE_CONSTRAINT'
  | 'DATABASE_CORRUPT'
  | 'DATABASE_ERROR'
  | 'DATABASE_IO'
  | 'DATABASE_VERSION_TOO_NEW'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_INVALID'
  | 'MIGRATION_FAILED'
  | 'ASYNC_TRANSACTION_NOT_ALLOWED'
  | 'NESTED_TRANSACTION_NOT_ALLOWED'
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

export function normalizePersistenceError(error: unknown): unknown {
  if (error instanceof PersistenceError) return error
  const code =
    error && typeof error === 'object' && 'code' in error
      ? Reflect.get(error, 'code')
      : undefined
  const errcode =
    error && typeof error === 'object' && 'errcode' in error
      ? Reflect.get(error, 'errcode')
      : undefined
  const primaryCode =
    typeof errcode === 'number' && Number.isInteger(errcode)
      ? errcode & 0xff
      : undefined
  if (
    primaryCode === undefined &&
    !(typeof code === 'string' && code.startsWith('ERR_SQLITE'))
  ) {
    return error
  }
  const detail = error instanceof Error ? `: ${error.message}` : ''

  if (primaryCode === 5 || primaryCode === 6) {
    return new PersistenceError(
      'DATABASE_BUSY',
      `SQLite database is busy or locked${detail}`,
      { cause: error },
    )
  }
  if (primaryCode === 10) {
    return new PersistenceError(
      'DATABASE_IO',
      `SQLite database I/O failed${detail}`,
      { cause: error },
    )
  }
  if (primaryCode === 11 || primaryCode === 26) {
    return new PersistenceError(
      'DATABASE_CORRUPT',
      `SQLite database is corrupt or invalid${detail}`,
      { cause: error },
    )
  }
  if (primaryCode === 19) {
    return new PersistenceError(
      'DATABASE_CONSTRAINT',
      `SQLite constraint violation${detail}`,
      { cause: error },
    )
  }
  return new PersistenceError(
    'DATABASE_ERROR',
    `SQLite operation failed${detail}`,
    { cause: error },
  )
}
