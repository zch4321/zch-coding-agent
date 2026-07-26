import type { ValidateFunction } from 'ajv'
import { formatSchemaErrors } from '../schema-validator'
import { PersistenceError } from './persistence-error'

/** Validates schema value and throws when it is invalid. */
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

/** Returns or updates string column state. */
export function stringColumn(value: unknown, column: string): string {
  if (typeof value === 'string') return value
  throw invalidColumn(column, 'string')
}

/** Returns or updates nullable string column state. */
export function nullableStringColumn(
  value: unknown,
  column: string,
): string | null {
  if (value === null || typeof value === 'string') return value
  throw invalidColumn(column, 'string or null')
}

/** Returns or updates date time column state. */
export function dateTimeColumn(value: unknown, column: string): string {
  const source = stringColumn(value, column)
  const timestamp = Date.parse(source)
  if (!Number.isFinite(timestamp)) {
    throw invalidColumn(column, 'valid date-time string')
  }
  return new Date(timestamp).toISOString()
}

/** Returns or updates nullable date time column state. */
export function nullableDateTimeColumn(
  value: unknown,
  column: string,
): string | null {
  return value === null ? null : dateTimeColumn(value, column)
}

/** Returns or updates integer column state. */
export function integerColumn(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw invalidColumn(column, 'safe integer')
}

/** Returns or updates boolean column state. */
export function booleanColumn(value: unknown, column: string): boolean {
  const integer = integerColumn(value, column)
  if (integer === 0) return false
  if (integer === 1) return true
  throw invalidColumn(column, 'SQLite boolean 0 or 1')
}

/** Parses json column. */
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

/** Parses nullable json column. */
export function parseNullableJsonColumn(
  value: unknown,
  column: string,
): unknown | null {
  return value === null ? null : parseJsonColumn(value, column)
}

/** Returns or updates encode json column state. */
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
