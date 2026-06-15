import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from './schema'

const validateAppConfig = compileSchema(AppConfigSchema)

function mergeRecord<T extends object>(defaults: T, candidate: unknown): T {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return structuredClone(defaults)
  }

  const result = structuredClone(defaults) as Record<string, unknown>

  for (const [key, value] of Object.entries(candidate)) {
    const defaultValue = result[key]

    if (
      defaultValue &&
      typeof defaultValue === 'object' &&
      !Array.isArray(defaultValue) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = mergeRecord(defaultValue as Record<string, unknown>, value)
    } else {
      result[key] = value
    }
  }

  return result as T
}

export function migrateConfig(candidate: unknown): AppConfig {
  if (candidate === undefined || candidate === null) {
    return structuredClone(DEFAULT_APP_CONFIG)
  }

  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Config root must be an object')
  }

  const schemaVersion = Reflect.get(candidate, 'schemaVersion')

  if (
    schemaVersion !== undefined &&
    schemaVersion !== 0 &&
    schemaVersion !== 1
  ) {
    throw new Error(
      `Unsupported config schema version: ${String(schemaVersion)}`,
    )
  }

  const migrated = mergeRecord(DEFAULT_APP_CONFIG, candidate)
  migrated.schemaVersion = 1

  if (!validateAppConfig(migrated)) {
    throw new Error(formatSchemaErrors(validateAppConfig.errors))
  }

  return migrated
}
