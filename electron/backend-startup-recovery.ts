import { PersistenceError } from './persistence/persistence-error'

export interface BackendStartupRecoveryPrompt {
  databaseRelated: boolean
  retryable: boolean
  message: string
  detail: string
}

/** Classifies backend startup failures without exposing raw error details. */
export function backendStartupRecoveryPrompt(
  error: unknown,
): BackendStartupRecoveryPrompt {
  if (!(error instanceof PersistenceError)) {
    return {
      databaseRelated: false,
      retryable: false,
      message: 'The durable backend could not be initialized.',
      detail:
        'Open the application data directory for diagnostics, then restart the application after resolving the problem.',
    }
  }

  const retryable =
    error.code === 'DATABASE_BUSY' || error.code === 'DATABASE_IO'
  return {
    databaseRelated: true,
    retryable,
    message: 'The local database could not be opened or migrated.',
    detail: retryable
      ? 'Retry after resolving the temporary database problem, open the data directory for recovery, or exit the application.'
      : 'Open the data directory for recovery, then restart the application after resolving the database problem.',
  }
}
