import { describe, expect, it } from 'vitest'
import { PersistenceError } from '../persistence/persistence-error'
import { DomainError } from '../common/domain-error'
import {
  ApplicationError,
  normalizeApplicationError,
} from './application-error'

describe('normalizeApplicationError', () => {
  it.each(['PRECONDITION_FAILED', 'CONFLICT', 'CANCELLED'] as const)(
    'preserves the %s domain failure across application boundaries',
    (code) => {
      const cause = new DomainError(code, 'Run cannot start', {
        details: { requiredVersion: 2 },
      })
      expect(normalizeApplicationError(cause)).toMatchObject({
        code,
        message: cause.message,
        details: cause.details,
        cause,
      })
    },
  )

  it('preserves explicit application failures', () => {
    const error = new ApplicationError('PRECONDITION_FAILED', 'Invalid input')

    expect(normalizeApplicationError(error)).toBe(error)
  })

  it('maps persistence failures without exposing driver details', () => {
    const cause = new PersistenceError(
      'DATABASE_IO',
      'SQLite failed at C:\\private\\agent.db',
    )

    expect(normalizeApplicationError(cause)).toMatchObject({
      code: 'PERSISTENCE_FAILURE',
      message: 'The durable state operation failed',
      cause,
    })
  })

  it('maps unknown failures to a safe internal error', () => {
    const cause = new Error('unexpected failure at C:\\private\\workspace')
    const normalized = normalizeApplicationError(cause)

    expect(normalized).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The application operation failed',
      cause,
    })
    expect(normalized.message).not.toContain(cause.message)
  })
})
