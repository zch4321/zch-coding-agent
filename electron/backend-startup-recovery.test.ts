import { describe, expect, it } from 'vitest'
import { PersistenceError } from './persistence/persistence-error'
import { backendStartupRecoveryPrompt } from './backend-startup-recovery'

describe('backend startup recovery', () => {
  it('allows retry only for transient persistence failures', () => {
    expect(
      backendStartupRecoveryPrompt(
        new PersistenceError('DATABASE_BUSY', 'database locked'),
      ),
    ).toMatchObject({ databaseRelated: true, retryable: true })
    expect(
      backendStartupRecoveryPrompt(
        new PersistenceError(
          'MIGRATION_CHECKSUM_MISMATCH',
          'deterministic mismatch',
        ),
      ),
    ).toMatchObject({ databaseRelated: true, retryable: false })
  })

  it('does not mislabel an unrelated backend initialization failure', () => {
    const prompt = backendStartupRecoveryPrompt(new Error('provider wiring'))

    expect(prompt).toMatchObject({
      databaseRelated: false,
      retryable: false,
    })
    expect(prompt.message).not.toContain('database')
  })
})
