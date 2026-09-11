import { PersistenceError } from '../persistence/persistence-error'
import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorOptions,
} from '../common/domain-error'

export type ApplicationErrorCode = DomainErrorCode

/** Represents a normalized failure crossing an application-service boundary. */
export class ApplicationError extends DomainError {
  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(code, message, options)
    this.name = 'ApplicationError'
  }
}

/** Maps application, persistence, and unknown failures to stable safe error codes. */
export function normalizeApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error
  if (error instanceof DomainError)
    return new ApplicationError(error.code, error.message, {
      details: error.details,
      cause: error.cause ?? error,
    })
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
    'INTERNAL_ERROR',
    'The application operation failed',
    { cause: error },
  )
}
