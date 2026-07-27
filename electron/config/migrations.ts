import { Type, type Static } from '@sinclair/typebox'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import {
  AppConfigSchema,
  AppProviderConfigSchema,
  DEFAULT_APP_CONFIG,
  type AppConfig,
} from './schema'

const validateAppConfig = compileSchema(AppConfigSchema)

function withoutKey<
  Value extends Record<string, unknown>,
  Key extends keyof Value,
>(value: Value, key: Key): Omit<Value, Key> {
  const clone = { ...value }
  Reflect.deleteProperty(clone, key)
  return clone
}

const legacyProviderProperties = withoutKey(
  AppProviderConfigSchema.properties,
  'providerType',
)
const legacyAppProperties = withoutKey(
  withoutKey(AppConfigSchema.properties, 'schemaVersion'),
  'providers',
)
const LegacyAppConfigV9Schema = Type.Object(
  {
    ...legacyAppProperties,
    schemaVersion: Type.Literal(9),
    providers: Type.Array(
      Type.Object(
        {
          ...legacyProviderProperties,
          protocol: Type.Literal('openai-compatible'),
          adapterId: Type.Union([
            Type.Literal('deepseek.chat-completions'),
            Type.Literal('openai-compatible.chat-completions'),
          ]),
          profile: Type.Union([
            Type.Literal('deepseek'),
            Type.Literal('generic'),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV9 = Static<typeof LegacyAppConfigV9Schema>
const validateLegacyAppConfigV9 = compileSchema(LegacyAppConfigV9Schema)

/** Reports that a persisted configuration uses an unsupported schema version. */
export class UnsupportedConfigSchemaError extends Error {
  constructor(
    readonly schemaVersion: unknown,
    validationErrors?: string,
  ) {
    super(
      `Unsupported config schema ${String(schemaVersion)}; this build requires AppConfig v10 and will reset the existing config to defaults.${
        validationErrors ? ` ${validationErrors}` : ''
      }`,
    )
    this.name = 'UnsupportedConfigSchemaError'
  }
}

/**
 * Migrates the P11 provider identity boundary while rejecting older epochs.
 */
export function migrateConfig(candidate: unknown): AppConfig {
  if (candidate === undefined || candidate === null) {
    return structuredClone(DEFAULT_APP_CONFIG)
  }

  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UnsupportedConfigSchemaError(
      candidate && typeof candidate === 'object'
        ? Reflect.get(candidate, 'schemaVersion')
        : undefined,
    )
  }

  if (Reflect.get(candidate, 'schemaVersion') === 9) {
    if (!validateLegacyAppConfigV9(candidate)) {
      throw new UnsupportedConfigSchemaError(
        9,
        formatSchemaErrors(validateLegacyAppConfigV9.errors),
      )
    }
    const legacy = candidate as LegacyAppConfigV9
    const migrated = {
      ...legacy,
      schemaVersion: 10 as const,
      providers: legacy.providers.map((provider) => {
        const adapterId = provider.adapterId
        const rest = withoutKey(
          withoutKey(withoutKey(provider, 'adapterId'), 'profile'),
          'protocol',
        )
        return {
          ...rest,
          providerType:
            adapterId === 'deepseek.chat-completions'
              ? ('deepseek.chat-completions' as const)
              : ('generic.chat-completions' as const),
        }
      }),
    }
    if (!validateAppConfig(migrated)) {
      throw new UnsupportedConfigSchemaError(
        9,
        formatSchemaErrors(validateAppConfig.errors),
      )
    }
    return structuredClone(migrated as AppConfig)
  }

  if (Reflect.get(candidate, 'schemaVersion') !== 10) {
    throw new UnsupportedConfigSchemaError(
      Reflect.get(candidate, 'schemaVersion'),
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
