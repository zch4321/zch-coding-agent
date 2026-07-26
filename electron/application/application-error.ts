import { PersistenceError } from '../persistence/persistence-error'

export type ApplicationErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RESOURCE_CHANGED'
  | 'PERSISTENCE_FAILURE'

/** Reports application failures. */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: {
      details?: Readonly<Record<string, unknown>>
      cause?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'ApplicationError'
    this.code = code
    this.details = options.details
    this.cause = options.cause
  }
}

/** Normalizes application error. */
export function normalizeApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error
  if (error instanceof PersistenceError) {
    if (error.code === 'DATABASE_CONSTRAINT') {
      return new ApplicationError(
        'CONFLICT',
        'The durable state conflicts with an existing record',
        { cause: error },
      )
    }
    return new ApplicationError(
      'PERSISTENCE_FAILURE',
      'The durable state operation failed',
      { cause: error },
    )
  }
  return new ApplicationError(
    'PERSISTENCE_FAILURE',
    'The durable state operation failed',
    { cause: error },
  )
}
