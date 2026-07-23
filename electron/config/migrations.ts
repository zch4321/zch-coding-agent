import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from './schema'

const validateAppConfig = compileSchema(AppConfigSchema)

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
    throw new Error(
      'Unsupported config schema. P3 requires AppConfig v9; reset or remove the existing config file.',
    )
  }

  if (!validateAppConfig(candidate)) {
    throw new Error(formatSchemaErrors(validateAppConfig.errors))
  }

  return structuredClone(candidate as AppConfig)
}
