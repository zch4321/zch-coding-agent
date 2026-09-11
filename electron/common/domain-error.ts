export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RESOURCE_CHANGED'
  | 'PERSISTENCE_FAILURE'
  | 'CANCELLED'
  | 'INTERNAL_ERROR'

export interface DomainErrorOptions {
  details?: Readonly<Record<string, unknown>>
  cause?: unknown
}

/** Carries a deliberate domain failure independently of IPC or a particular host. */
export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown

  constructor(
    code: DomainErrorCode,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = options.details
    this.cause = options.cause
  }
}
