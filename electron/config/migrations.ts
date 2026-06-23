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
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3 &&
    schemaVersion !== 4
  ) {
    throw new Error(
      `Unsupported config schema version: ${String(schemaVersion)}`,
    )
  }

  const normalized = normalizeConfigShape(candidate)
  const migrated = mergeRecord(DEFAULT_APP_CONFIG as AppConfig, normalized)
  migrated.schemaVersion = 4
  migrated.providers = migrated.providers.map((provider) => ({
    ...provider,
    reasoning: normalizeReasoning(provider.reasoning),
  }))

  if (
    !migrated.providers.some(
      (provider) => provider.id === migrated.activeProviderId,
    )
  ) {
    migrated.activeProviderId = migrated.providers[0]?.id ?? 'deepseek'
  }

  if (
    !migrated.providers.some(
      (provider) => provider.id === migrated.approval.approverProviderId,
    )
  ) {
    migrated.approval.approverProviderId = migrated.activeProviderId
  }

  if (!validateAppConfig(migrated)) {
    throw new Error(formatSchemaErrors(validateAppConfig.errors))
  }

  return migrated
}

function normalizeReasoning(value: unknown): 'off' | 'high' | 'max' {
  if (value === 'off' || value === 'max') {
    return value
  }

  // DeepSeek only documents high/max. Legacy `auto`, mistakenly exposed `low`,
  // OpenAI-compatible `medium`, and `xhigh` compatibility aliases are folded to
  // the nearest documented DeepSeek value.
  if (value === 'xhigh') {
    return 'max'
  }

  return 'high'
}

function normalizeConfigShape(candidate: object): Record<string, unknown> {
  const raw = structuredClone(candidate) as Record<string, unknown>
  const legacyProviders = raw.providers

  if (!Array.isArray(legacyProviders)) {
    const deepseek =
      legacyProviders &&
      typeof legacyProviders === 'object' &&
      !Array.isArray(legacyProviders)
        ? Reflect.get(legacyProviders, 'deepseek')
        : undefined
    const legacyDeepSeek =
      deepseek && typeof deepseek === 'object' && !Array.isArray(deepseek)
        ? (deepseek as Record<string, unknown>)
        : {}

    raw.providers = [
      {
        ...structuredClone(DEFAULT_APP_CONFIG.providers[0]),
        ...legacyDeepSeek,
        id: 'deepseek',
        label: 'DeepSeek',
        protocol: 'openai-compatible',
        profile: 'deepseek',
        reasoning: normalizeReasoning(legacyDeepSeek.reasoning),
      },
    ]
    raw.activeProviderId =
      typeof raw.activeProviderId === 'string'
        ? raw.activeProviderId
        : typeof raw.activeProvider === 'string'
          ? raw.activeProvider
          : 'deepseek'
    delete raw.activeProvider
  } else {
    raw.providers = legacyProviders.map((provider, index) => {
      const current =
        provider && typeof provider === 'object' && !Array.isArray(provider)
          ? (provider as Record<string, unknown>)
          : {}
      const id =
        typeof current.id === 'string' && current.id
          ? current.id
          : index === 0
            ? 'deepseek'
            : `provider-${index + 1}`

      return {
        ...structuredClone(DEFAULT_APP_CONFIG.providers[0]),
        ...current,
        id,
        label:
          typeof current.label === 'string' && current.label
            ? current.label
            : id === 'deepseek'
              ? 'DeepSeek'
              : id,
        protocol: 'openai-compatible',
        profile:
          current.profile === 'generic' || current.profile === 'deepseek'
            ? current.profile
            : id === 'deepseek'
              ? 'deepseek'
              : 'generic',
        reasoning: normalizeReasoning(current.reasoning),
      }
    })
  }

  if (
    raw.approval &&
    typeof raw.approval === 'object' &&
    !Array.isArray(raw.approval)
  ) {
    const approval = raw.approval as Record<string, unknown>
    if (
      typeof approval.approverProviderId !== 'string' &&
      typeof approval.approverProvider === 'string'
    ) {
      approval.approverProviderId = approval.approverProvider
    }
    delete approval.approverProvider
  }

  return raw
}
