import type { ValidateFunction } from 'ajv'
import { formatSchemaErrors } from '../schema-validator'
import { PersistenceError } from './persistence-error'

/** Validates a decoded database value against its schema with contextual error details. */
export function assertSchemaValue<Value>(
  validate: ValidateFunction,
  value: unknown,
  label: string,
): asserts value is Value {
  if (validate(value)) return
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} failed schema validation: ${formatSchemaErrors(validate.errors)}`,
  )
}

/** Reads a required text column from a SQLite row. */
export function stringColumn(value: unknown, column: string): string {
  if (typeof value === 'string') return value
  throw invalidColumn(column, 'string')
}

/** Reads a nullable text column from a SQLite row. */
export function nullableStringColumn(
  value: unknown,
  column: string,
): string | null {
  if (value === null || typeof value === 'string') return value
  throw invalidColumn(column, 'string or null')
}

/** Parses a required ISO timestamp column from a SQLite row. */
export function dateTimeColumn(value: unknown, column: string): string {
  const source = stringColumn(value, column)
  const timestamp = Date.parse(source)
  if (!Number.isFinite(timestamp)) {
    throw invalidColumn(column, 'valid date-time string')
  }
  return new Date(timestamp).toISOString()
}

/** Parses an optional ISO timestamp column from a SQLite row. */
export function nullableDateTimeColumn(
  value: unknown,
  column: string,
): string | null {
  return value === null ? null : dateTimeColumn(value, column)
}

/** Reads a required safe integer column from a SQLite row. */
export function integerColumn(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw invalidColumn(column, 'safe integer')
}

/** Decodes SQLite's integer boolean representation from a required column. */
export function booleanColumn(value: unknown, column: string): boolean {
  const integer = integerColumn(value, column)
  if (integer === 0) return false
  if (integer === 1) return true
  throw invalidColumn(column, 'SQLite boolean 0 or 1')
}

/** Parses and validates a required JSON column from a SQLite row. */
export function parseJsonColumn(value: unknown, column: string): unknown {
  const source = stringColumn(value, column)
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    throw new PersistenceError(
      'CODEC_INVALID',
      `${column} contains invalid JSON`,
      { cause: error },
    )
  }
}

/** Parses an optional JSON column, preserving SQL NULL as undefined. */
export function parseNullableJsonColumn(
  value: unknown,
  column: string,
): unknown | null {
  return value === null ? null : parseJsonColumn(value, column)
}

/** Serializes a bounded JSON value for storage in a SQLite text column. */
export function encodeJsonColumn(value: unknown, column: string): string {
  const encoded = JSON.stringify(value)
  if (encoded !== undefined) return encoded
  throw new PersistenceError(
    'CODEC_INVALID',
    `${column} is not JSON-serializable`,
  )
}

function invalidColumn(column: string, expected: string): PersistenceError {
  return new PersistenceError(
    'CODEC_INVALID',
    `${column} must be a ${expected}`,
  )
}
