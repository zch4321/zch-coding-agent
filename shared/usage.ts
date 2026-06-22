import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema } from './json'

export const LlmUsageScopeSchema = Type.Union([
  Type.Literal('main'),
  Type.Literal('approval'),
  Type.Literal('title'),
  Type.Literal('compression'),
])

export const ContextWindowSourceSchema = Type.Union([
  Type.Literal('override'),
  Type.Literal('builtin'),
  Type.Literal('default'),
  Type.Literal('provider'),
])

const OptionalTokenMetricSchema = Type.Optional(
  Type.Integer({ minimum: 0, maximum: 10_000_000_000 }),
)

export const LlmUsageRecordSchema = Type.Object(
  {
    scope: LlmUsageScopeSchema,
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    providerLabel: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    promptTokens: OptionalTokenMetricSchema,
    completionTokens: OptionalTokenMetricSchema,
    totalTokens: OptionalTokenMetricSchema,
    reasoningTokens: OptionalTokenMetricSchema,
    cacheHitTokens: OptionalTokenMetricSchema,
    cacheMissTokens: OptionalTokenMetricSchema,
    contextWindowTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    contextWindowSource: ContextWindowSourceSchema,
    raw: JsonValueSchema,
  },
  { additionalProperties: false },
)

export type LlmUsageRecord = Static<typeof LlmUsageRecordSchema>
