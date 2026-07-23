import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from './schema'

const validateAppConfig = compileSchema(AppConfigSchema)

export class UnsupportedConfigSchemaError extends Error {
  constructor(
    readonly schemaVersion: unknown,
    validationErrors?: string,
  ) {
    super(
      `Unsupported config schema. P3 requires AppConfig v9; the existing config will be reset to defaults.${
        validationErrors ? ` ${validationErrors}` : ''
      }`,
    )
    this.name = 'UnsupportedConfigSchemaError'
  }
}

/**
 * P3 intentionally starts a clean configuration epoch. Older schemas mixed
 * provider identity, protocol behavior, and mutable defaults, so guessing an
 * adapter or revision would produce an unreproducible route snapshot.
 */
export function migrateConfig(candidate: unknown): AppConfig {
  if (candidate === undefined || candidate === null) {
    return structuredClone(DEFAULT_APP_CONFIG)
  }

  if (
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Reflect.get(candidate, 'schemaVersion') !== 9
  ) {
    throw new UnsupportedConfigSchemaError(
      candidate && typeof candidate === 'object'
        ? Reflect.get(candidate, 'schemaVersion')
        : undefined,
    )
  }

  if (!validateAppConfig(candidate)) {
    throw new UnsupportedConfigSchemaError(
      Reflect.get(candidate, 'schemaVersion'),
      formatSchemaErrors(validateAppConfig.errors),
    )
  }

  return structuredClone(candidate as AppConfig)
}
