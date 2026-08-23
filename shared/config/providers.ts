import { Type, type Static } from '@sinclair/typebox'
import { ReasoningEffortSchema, type ReasoningEffort } from '../reasoning'

export const DeepSeekReasoningEffortSchema = ReasoningEffortSchema
export type DeepSeekReasoningEffort = ReasoningEffort

export const ModelCapabilityLevelSchema = Type.Union([
  Type.Literal('light'),
  Type.Literal('standard'),
  Type.Literal('strong'),
])
export type ModelCapabilityLevel = Static<typeof ModelCapabilityLevelSchema>

export const ProviderModelSchema = Type.Object(
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
export type ProviderModel = Static<typeof ProviderModelSchema>

export const ModelCapabilityOverrideSchema = Type.Object(
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
    reasoningEfforts: Type.Optional(
      Type.Array(ReasoningEffortSchema, { minItems: 1, uniqueItems: true }),
    ),
    capability: Type.Optional(ModelCapabilityLevelSchema),
  },
  { additionalProperties: false },
)
export type ModelCapabilityOverride = Static<
  typeof ModelCapabilityOverrideSchema
>

export const ProviderTypeSchema = Type.Union([
  Type.Literal('deepseek.chat-completions'),
  Type.Literal('mimo.chat-completions'),
  Type.Literal('generic.chat-completions'),
  Type.Literal('generic.responses'),
  Type.Literal('generic.anthropic'),
])
export type ProviderType = Static<typeof ProviderTypeSchema>

export const ProviderPublicConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    providerType: ProviderTypeSchema,
    revision: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
    model: Type.String({ maxLength: 256 }),
    modelCatalog: Type.Array(ProviderModelSchema, { maxItems: 1_000 }),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides: Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      ModelCapabilityOverrideSchema,
      { maxProperties: 1_000 },
    ),
    enabledModelIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 1_000,
      uniqueItems: true,
    }),
    credentialConfigured: Type.Boolean(),
    credentialSource: Type.Union([
      Type.Literal('none'),
      Type.Literal('safe-storage'),
      Type.Literal('environment'),
    ]),
  },
  { additionalProperties: false },
)
export type ProviderPublicConfig = Static<typeof ProviderPublicConfigSchema>
