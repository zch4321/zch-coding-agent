import { Type, type Static } from '@sinclair/typebox'
import {
  APP_CONFIG_SCHEMA_VERSION,
  PermissionModeSchema,
  PublicConfigSchema,
  ReasoningEffortSchema,
  RememberedRuleSchema,
  normalizeModelPoolConfig,
} from '../../shared/config'
import { McpServerConfigSchema } from '../../shared/mcp'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from './schema'

const validateAppConfig = compileSchema(AppConfigSchema)

function withoutKey<
  Value extends Record<string, unknown>,
  Key extends keyof Value,
>(value: Value, key: Key): Omit<Value, Key> {
  const clone = { ...value }
  Reflect.deleteProperty(clone, key)
  return clone
}

const LegacyLimitsWithRunToolBudgetSchema = Type.Object(
  {
    ...PublicConfigSchema.properties.limits.properties,
    maxToolTokensPerRun: Type.Integer({
      minimum: 256,
      maximum: 10_000_000,
    }),
  },
  { additionalProperties: false },
)
type LegacyLimitsWithRunToolBudget = Static<
  typeof LegacyLimitsWithRunToolBudgetSchema
>

// This root and Provider shape is the frozen AppConfig v9 boundary. Do not
// derive it from AppConfigSchema/AppProviderConfigSchema; the literal v9 test
// fixture must fail loudly if a reused stable shared subsection ever drifts.

// Frozen v9-era reasoning efforts (three levels). Never reuse the current
// ReasoningEffortSchema here: later enum values must be rejected as not v9.
const LegacyReasoningEffortV9Schema = Type.Union([
  Type.Literal('off'),
  Type.Literal('high'),
  Type.Literal('max'),
])

// Frozen v9-era per-model override shape: token limits only, no annotations.
const LegacyModelCapabilityOverrideV9Schema = Type.Object(
  {
    contextWindowTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    compactThresholdTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
  },
  { additionalProperties: false },
)

const LegacyModelOverridesV9Schema = Type.Record(
  Type.String(),
  LegacyModelCapabilityOverrideV9Schema,
  { maxProperties: 1_000 },
)

// Frozen v9-era catalog model shape (identity plus optional token fields).
const LegacyProviderModelV9Schema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    ownedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    contextWindowTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
  },
  { additionalProperties: false },
)

const LegacyAppProviderConfigV9Schema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    protocol: Type.Literal('openai-compatible'),
    adapterId: Type.Union([
      Type.Literal('deepseek.chat-completions'),
      Type.Literal('openai-compatible.chat-completions'),
    ]),
    revision: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    profile: Type.Union([Type.Literal('deepseek'), Type.Literal('generic')]),
    baseURL: Type.String({ minLength: 1, maxLength: 2_048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: LegacyReasoningEffortV9Schema,
    modelCatalog: Type.Array(LegacyProviderModelV9Schema, { maxItems: 1_000 }),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides: LegacyModelOverridesV9Schema,
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)

const LegacyAppConfigV9Schema = Type.Object(
  {
    schemaVersion: Type.Literal(9),
    activeProviderId: Type.String({ minLength: 1, maxLength: 128 }),
    providers: Type.Array(LegacyAppProviderConfigV9Schema, {
      minItems: 1,
      maxItems: 32,
    }),
    approval: PublicConfigSchema.properties.approval,
    permission: Type.Object(
      {
        defaultMode: PermissionModeSchema,
        builtinPolicies: Type.Boolean(),
        rememberedRules: Type.Array(RememberedRuleSchema, { maxItems: 256 }),
        sensitiveData:
          PublicConfigSchema.properties.permission.properties.sensitiveData,
      },
      { additionalProperties: false },
    ),
    limits: LegacyLimitsWithRunToolBudgetSchema,
    logging: PublicConfigSchema.properties.logging,
    privacy: PublicConfigSchema.properties.privacy,
    workspace: PublicConfigSchema.properties.workspace,
    skills: PublicConfigSchema.properties.skills,
    assistant: PublicConfigSchema.properties.assistant,
    prompts: PublicConfigSchema.properties.prompts,
    network: PublicConfigSchema.properties.network,
    webSearch: Type.Object(
      {
        provider: Type.Literal('brave'),
        apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        count: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    mcpServers: Type.Array(McpServerConfigSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV9 = Static<typeof LegacyAppConfigV9Schema>
const validateLegacyAppConfigV9 = compileSchema(LegacyAppConfigV9Schema)

const LegacyModelConfigurationIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 256 }),
  { maxItems: 1_000, uniqueItems: true },
)

// AppConfig v15 is frozen independently from the current root and Provider
// schemas so adding future configuration cannot silently change its boundary.
const LegacyAppProviderConfigV15Schema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    providerType:
      PublicConfigSchema.properties.providers.items.properties.providerType,
    revision: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    baseURL: Type.String({ minLength: 1, maxLength: 2_048 }),
    model: Type.String({ maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    modelCatalog:
      PublicConfigSchema.properties.providers.items.properties.modelCatalog,
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides:
      PublicConfigSchema.properties.providers.items.properties.modelOverrides,
    enabledModelIds:
      PublicConfigSchema.properties.providers.items.properties.enabledModelIds,
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)

const LegacyAppWebSearchConfigV15Schema = Type.Object(
  {
    provider: Type.Literal('brave'),
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    count: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
)

const LegacyAppConfigV15Schema = Type.Object(
  {
    schemaVersion: Type.Literal(15),
    activeProviderId: Type.String({ minLength: 1, maxLength: 128 }),
    providers: Type.Array(LegacyAppProviderConfigV15Schema, {
      minItems: 1,
      maxItems: 32,
    }),
    approval: PublicConfigSchema.properties.approval,
    subagents: PublicConfigSchema.properties.subagents,
    permission: PublicConfigSchema.properties.permission,
    limits: PublicConfigSchema.properties.limits,
    logging: PublicConfigSchema.properties.logging,
    privacy: PublicConfigSchema.properties.privacy,
    workspace: PublicConfigSchema.properties.workspace,
    skills: PublicConfigSchema.properties.skills,
    assistant: PublicConfigSchema.properties.assistant,
    prompts: PublicConfigSchema.properties.prompts,
    network: PublicConfigSchema.properties.network,
    webSearch: LegacyAppWebSearchConfigV15Schema,
    mcpServers: Type.Array(McpServerConfigSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV15 = Static<typeof LegacyAppConfigV15Schema>
const validateLegacyAppConfigV15 = compileSchema(LegacyAppConfigV15Schema)

const LegacyAppProviderConfigV14Schema = Type.Object(
  {
    ...withoutKey(
      LegacyAppProviderConfigV15Schema.properties,
      'enabledModelIds',
    ),
    // The v14 boundary predates the six-level enum and per-model annotations;
    // freeze the v14-era shapes instead of inheriting the current schema.
    reasoning: LegacyReasoningEffortV9Schema,
    modelCatalog: Type.Array(LegacyProviderModelV9Schema, { maxItems: 1_000 }),
    modelOverrides: LegacyModelOverridesV9Schema,
    model: Type.String({ minLength: 1, maxLength: 256 }),
    modelConfigurationIds: LegacyModelConfigurationIdsSchema,
  },
  { additionalProperties: false },
)

const LegacyAppConfigV14Schema = Type.Object(
  {
    ...LegacyAppConfigV15Schema.properties,
    schemaVersion: Type.Literal(14),
    providers: Type.Array(LegacyAppProviderConfigV14Schema, {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV14 = Static<typeof LegacyAppConfigV14Schema>
const validateLegacyAppConfigV14 = compileSchema(LegacyAppConfigV14Schema)

const LegacyAppConfigV13Schema = Type.Object(
  {
    ...LegacyAppConfigV14Schema.properties,
    schemaVersion: Type.Literal(13),
    limits: LegacyLimitsWithRunToolBudgetSchema,
  },
  { additionalProperties: false },
)
type LegacyAppConfigV13 = Static<typeof LegacyAppConfigV13Schema>
const validateLegacyAppConfigV13 = compileSchema(LegacyAppConfigV13Schema)

const LegacyAppConfigV12Schema = Type.Object(
  {
    ...withoutKey(LegacyAppConfigV13Schema.properties, 'subagents'),
    schemaVersion: Type.Literal(12),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV12 = Static<typeof LegacyAppConfigV12Schema>
const validateLegacyAppConfigV12 = compileSchema(LegacyAppConfigV12Schema)

const LegacyAppProviderConfigV11Schema = Type.Object(
  withoutKey(
    LegacyAppProviderConfigV14Schema.properties,
    'modelConfigurationIds',
  ),
  { additionalProperties: false },
)

const LegacyAppConfigV11Schema = Type.Object(
  {
    ...LegacyAppConfigV12Schema.properties,
    schemaVersion: Type.Literal(11),
    providers: Type.Array(LegacyAppProviderConfigV11Schema, {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV11 = Static<typeof LegacyAppConfigV11Schema>
const validateLegacyAppConfigV11 = compileSchema(LegacyAppConfigV11Schema)

// AppConfig v10 has the v11 Provider shape with the previous version literal.
// It is retained so existing Provider Foundation installs can adopt the larger
// tool/read defaults without losing credentials, catalogs, or custom limits.
const LegacyAppConfigV10Schema = Type.Object(
  {
    ...LegacyAppConfigV11Schema.properties,
    schemaVersion: Type.Literal(10),
  },
  { additionalProperties: false },
)
type LegacyAppConfigV10 = Static<typeof LegacyAppConfigV10Schema>
const validateLegacyAppConfigV10 = compileSchema(LegacyAppConfigV10Schema)

function withoutRunToolBudget(
  limits: LegacyLimitsWithRunToolBudget,
): AppConfig['limits'] {
  return structuredClone(
    withoutKey(limits, 'maxToolTokensPerRun'),
  ) as AppConfig['limits']
}

function migrateLimitDefaults(limits: LegacyAppConfigV10['limits']) {
  const next = withoutRunToolBudget(limits)

  if (next.maxToolOutputBytes === 64 * 1_024) {
    next.maxToolOutputBytes = 128 * 1_024
  }
  if (next.maxToolResultTokens === 8_000) {
    next.maxToolResultTokens = 64_000
  }
  if (next.readFileOutputBytes === 64 * 1_024) {
    next.readFileOutputBytes = 128 * 1_024
  }

  return next
}

function migrateV10(config: LegacyAppConfigV10): AppConfig {
  const migrated = {
    ...config,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    subagents: structuredClone(DEFAULT_APP_CONFIG.subagents),
    modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    limits: migrateLimitDefaults(config.limits),
    providers: config.providers.map((provider) => ({
      ...provider,
      enabledModelIds: [provider.model],
    })),
  }
  if (!validateAppConfig(migrated)) {
    throw new UnsupportedConfigSchemaError(
      10,
      formatSchemaErrors(validateAppConfig.errors),
    )
  }
  return structuredClone(migrated as AppConfig)
}

function migrateV11(config: LegacyAppConfigV11): AppConfig {
  const migrated = {
    ...config,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    subagents: structuredClone(DEFAULT_APP_CONFIG.subagents),
    modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    limits: withoutRunToolBudget(config.limits),
    providers: config.providers.map((provider) => ({
      ...provider,
      enabledModelIds: [provider.model],
    })),
  }
  if (!validateAppConfig(migrated)) {
    throw new UnsupportedConfigSchemaError(
      11,
      formatSchemaErrors(validateAppConfig.errors),
    )
  }
  return structuredClone(migrated as AppConfig)
}

function migrateV12(config: LegacyAppConfigV12): AppConfig {
  const migrated = {
    ...config,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    subagents: structuredClone(DEFAULT_APP_CONFIG.subagents),
    modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    limits: withoutRunToolBudget(config.limits),
    providers: config.providers.map((provider) => ({
      ...withoutKey(provider, 'modelConfigurationIds'),
      enabledModelIds: [...provider.modelConfigurationIds],
    })),
  }
  if (!validateAppConfig(migrated)) {
    throw new UnsupportedConfigSchemaError(
      12,
      formatSchemaErrors(validateAppConfig.errors),
    )
  }
  return structuredClone(migrated as AppConfig)
}

function migrateV13(config: LegacyAppConfigV13): AppConfig {
  const migrated = {
    ...config,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    limits: withoutRunToolBudget(config.limits),
    providers: config.providers.map((provider) => ({
      ...withoutKey(provider, 'modelConfigurationIds'),
      enabledModelIds: [...provider.modelConfigurationIds],
    })),
  }
  if (!validateAppConfig(migrated)) {
    throw new UnsupportedConfigSchemaError(
      13,
      formatSchemaErrors(validateAppConfig.errors),
    )
  }
  return structuredClone(migrated as AppConfig)
}

function migrateV14(config: LegacyAppConfigV14): AppConfig {
  const migrated = {
    ...config,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    providers: config.providers.map((provider) => ({
      ...withoutKey(provider, 'modelConfigurationIds'),
      enabledModelIds: [...provider.modelConfigurationIds],
    })),
  }
  if (!validateAppConfig(migrated)) {
    throw new UnsupportedConfigSchemaError(
      14,
      formatSchemaErrors(validateAppConfig.errors),
    )
  }
  return structuredClone(migrated as AppConfig)
}

/** Reports that a persisted configuration uses an unsupported schema version. */
export class UnsupportedConfigSchemaError extends Error {
  constructor(
    readonly schemaVersion: unknown,
    validationErrors?: string,
  ) {
    super(
      `Unsupported config schema ${String(schemaVersion)}; this build requires AppConfig v${APP_CONFIG_SCHEMA_VERSION} and will reset the existing config to defaults.${
        validationErrors ? ` ${validationErrors}` : ''
      }`,
    )
    this.name = 'UnsupportedConfigSchemaError'
  }
}

/**
 * Migrates Provider identity, model selections, Subagents, and the model pool.
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
      schemaVersion: APP_CONFIG_SCHEMA_VERSION,
      subagents: structuredClone(DEFAULT_APP_CONFIG.subagents),
      modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
      limits: migrateLimitDefaults(legacy.limits),
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
          enabledModelIds: [provider.model],
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

  if (Reflect.get(candidate, 'schemaVersion') === 10) {
    if (!validateLegacyAppConfigV10(candidate)) {
      throw new UnsupportedConfigSchemaError(
        10,
        formatSchemaErrors(validateLegacyAppConfigV10.errors),
      )
    }
    return migrateV10(candidate as LegacyAppConfigV10)
  }

  if (Reflect.get(candidate, 'schemaVersion') === 11) {
    if (!validateLegacyAppConfigV11(candidate)) {
      throw new UnsupportedConfigSchemaError(
        11,
        formatSchemaErrors(validateLegacyAppConfigV11.errors),
      )
    }
    return migrateV11(candidate as LegacyAppConfigV11)
  }

  if (Reflect.get(candidate, 'schemaVersion') === 12) {
    if (!validateLegacyAppConfigV12(candidate)) {
      throw new UnsupportedConfigSchemaError(
        12,
        formatSchemaErrors(validateLegacyAppConfigV12.errors),
      )
    }
    return migrateV12(candidate as LegacyAppConfigV12)
  }

  if (Reflect.get(candidate, 'schemaVersion') === 13) {
    if (!validateLegacyAppConfigV13(candidate)) {
      throw new UnsupportedConfigSchemaError(
        13,
        formatSchemaErrors(validateLegacyAppConfigV13.errors),
      )
    }
    return migrateV13(candidate as LegacyAppConfigV13)
  }

  if (Reflect.get(candidate, 'schemaVersion') === 14) {
    if (!validateLegacyAppConfigV14(candidate)) {
      throw new UnsupportedConfigSchemaError(
        14,
        formatSchemaErrors(validateLegacyAppConfigV14.errors),
      )
    }
    return migrateV14(candidate as LegacyAppConfigV14)
  }

  if (Reflect.get(candidate, 'schemaVersion') === 15) {
    if (!validateLegacyAppConfigV15(candidate)) {
      throw new UnsupportedConfigSchemaError(
        15,
        formatSchemaErrors(validateLegacyAppConfigV15.errors),
      )
    }
    const migrated = {
      ...(candidate as LegacyAppConfigV15),
      schemaVersion: APP_CONFIG_SCHEMA_VERSION,
      modelPool: structuredClone(DEFAULT_APP_CONFIG.modelPool),
    }
    if (!validateAppConfig(migrated)) {
      throw new UnsupportedConfigSchemaError(
        15,
        formatSchemaErrors(validateAppConfig.errors),
      )
    }
    return structuredClone(migrated as AppConfig)
  }

  if (Reflect.get(candidate, 'schemaVersion') !== APP_CONFIG_SCHEMA_VERSION) {
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

  try {
    return {
      ...structuredClone(candidate as AppConfig),
      modelPool: normalizeModelPoolConfig((candidate as AppConfig).modelPool),
    }
  } catch (error) {
    throw new UnsupportedConfigSchemaError(
      APP_CONFIG_SCHEMA_VERSION,
      error instanceof Error ? error.message : 'Invalid model pool',
    )
  }
}
