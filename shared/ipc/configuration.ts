import { Type, type Static } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { CommandShellCatalogSchema } from '../command-shell'
import { ModelRolesConfigSchema } from '../config/models'
import {
  ModelCapabilityLevelSchema,
  ModelCapabilityOverrideSchema,
  ProviderPublicConfigSchema,
  ProviderTypeSchema,
} from '../config/providers'
import { PublicConfigSchema } from '../config/public-config'
import { PermissionModeSchema, RememberedRuleSchema } from '../config/security'
import {
  ModelPoolConfigSchema,
  ModelPoolProviderRevisionSchema,
} from '../model-pool'
import { ReasoningEffortSchema } from '../reasoning'
import { ipcResultSchema } from './common'

export const ConfigSectionSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('providers'),
  Type.Literal('models'),
  Type.Literal('subagents'),
  Type.Literal('modelPool'),
  Type.Literal('executionEnvironment'),
  Type.Literal('permission'),
  Type.Literal('limits'),
  Type.Literal('logging'),
  Type.Literal('privacy'),
  Type.Literal('workspace'),
  Type.Literal('skills'),
  Type.Literal('assistant'),
  Type.Literal('prompts'),
  Type.Literal('network'),
  Type.Literal('webSearch'),
  Type.Literal('mcp'),
])
export type ConfigSection = Static<typeof ConfigSectionSchema>

// Configuration writes use one discriminated IPC payload union.
export const ConfigSetRequestSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('model-pool'),
      value: ModelPoolConfigSchema,
      expectedProviderRevisions: Type.Array(ModelPoolProviderRevisionSchema, {
        maxItems: 32,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      providerType: Type.Optional(ProviderTypeSchema),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ maxLength: 256 }),
      enabledModelIds: Type.Optional(
        ProviderPublicConfigSchema.properties.enabledModelIds,
      ),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      compactThresholdTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      maxOutputTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      modelOverrides: Type.Optional(
        Type.Record(
          Type.String({ minLength: 1, maxLength: 256 }),
          ModelCapabilityOverrideSchema,
          { maxProperties: 1_000 },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-settings'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      providerType: Type.Optional(ProviderTypeSchema),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ maxLength: 256 }),
      enabledModelIds: Type.Optional(
        ProviderPublicConfigSchema.properties.enabledModelIds,
      ),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      compactThresholdTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      maxOutputTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      modelOverrides: Type.Optional(
        Type.Record(
          Type.String({ minLength: 1, maxLength: 256 }),
          ModelCapabilityOverrideSchema,
          { maxProperties: 1_000 },
        ),
      ),
      limits: PublicConfigSchema.properties.limits,
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-model-add'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
      modelOverride: Type.Optional(ModelCapabilityOverrideSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-model-delete'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-copy'),
      sourceProviderId: Type.String({ minLength: 1, maxLength: 128 }),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      label: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-delete'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      fallbackProviderId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128 }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      action: Type.Literal('set'),
      apiKey: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      action: Type.Literal('clear'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('models'),
      value: ModelRolesConfigSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('subagents'),
      value: PublicConfigSchema.properties.subagents,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('execution-environment'),
      value: PublicConfigSchema.properties.executionEnvironment,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('permission'),
      defaultMode: PermissionModeSchema,
      builtinPolicies: Type.Boolean(),
      rememberedRules: Type.Array(RememberedRuleSchema, { maxItems: 256 }),
      sensitiveData: Type.Object(
        {
          mode: Type.Union([
            Type.Literal('off'),
            Type.Literal('warn'),
            Type.Literal('confirm'),
          ]),
          pathGlobs: Type.Array(Type.String({ maxLength: 1024 }), {
            maxItems: 256,
          }),
          contentPatterns: Type.Array(Type.String({ maxLength: 2048 }), {
            maxItems: 256,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('limits'),
      value: PublicConfigSchema.properties.limits,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('logging'),
      value: PublicConfigSchema.properties.logging,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('privacy'),
      providerNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.providerNoticeAccepted,
      ),
      traceNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.traceNoticeAccepted,
      ),
      yoloNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.yoloNoticeAccepted,
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('workspace'),
      lastOpened: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('skills'),
      value: PublicConfigSchema.properties.skills,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('assistant'),
      value: PublicConfigSchema.properties.assistant,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('prompts'),
      value: PublicConfigSchema.properties.prompts,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('network'),
      value: PublicConfigSchema.properties.network,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('web-search'),
      provider: Type.Union([Type.Literal('brave')]),
      count: Type.Integer({ minimum: 1, maximum: 20 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('web-search-credential'),
      action: Type.Union([Type.Literal('set'), Type.Literal('clear')]),
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    },
    { additionalProperties: false },
  ),
])
export type ConfigSetRequest = Static<typeof ConfigSetRequestSchema>

const ModelProfileSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    ownedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    availability: Type.Union([
      Type.Literal('provider'),
      Type.Literal('custom'),
    ]),
    capabilitySource: Type.Union([
      Type.Literal('override'),
      Type.Literal('provider'),
      Type.Literal('builtin'),
      Type.Literal('default'),
    ]),
    contextWindowTokens: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    compactThresholdTokens: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    maxOutputTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    reasoningEfforts: Type.Optional(
      Type.Array(ReasoningEffortSchema, { minItems: 1, uniqueItems: true }),
    ),
    capability: Type.Optional(ModelCapabilityLevelSchema),
  },
  { additionalProperties: false },
)

export const CONFIGURATION_IPC_CONTRACTS = {
  'config:get': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        section: ConfigSectionSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          section: ConfigSectionSchema,
          config: PublicConfigSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  'config:set': {
    payload: ConfigSetRequestSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          config: PublicConfigSchema,
          warnings: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
              maxItems: 512,
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'command-shell:list': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        refresh: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(CommandShellCatalogSchema),
  },
} as const

export const PROVIDER_IPC_CONTRACTS = {
  'provider:list-models': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        refresh: Type.Boolean(),
        providerId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 128 }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          models: Type.Array(ModelProfileSchema, { maxItems: 1_000 }),
          fetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
          stale: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
} as const
