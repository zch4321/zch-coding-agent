import { Type, type Static } from '@sinclair/typebox'
import { SessionIdSchema, RunIdSchema, AgentExecutionIdSchema } from './ids'
import { LlmUsageRecordSchema, LlmUsageScopeSchema } from './usage'

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const metric = Type.Optional(count)
export const USAGE_METRICS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'reasoningTokens',
  'cacheHitTokens',
  'cacheMissTokens',
] as const
export const UsageTotalsSchema = Type.Object(
  {
    calls: count,
    promptTokens: metric,
    completionTokens: metric,
    totalTokens: metric,
    reasoningTokens: metric,
    cacheHitTokens: metric,
    cacheMissTokens: metric,
  },
  { additionalProperties: false },
)
export type UsageTotals = Static<typeof UsageTotalsSchema>

export const UsageModelSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    providerLabel: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    totals: UsageTotalsSchema,
  },
  { additionalProperties: false },
)
export const UsageTaskSchema = Type.Object(
  {
    executionId: AgentExecutionIdSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    totals: UsageTotalsSchema,
  },
  { additionalProperties: false },
)
export const UsageScopeSummarySchema = Type.Object(
  {
    scope: LlmUsageScopeSchema,
    totals: UsageTotalsSchema,
    models: Type.Array(UsageModelSchema, { maxItems: 100 }),
    tasks: Type.Array(UsageTaskSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
)
export const UsageSummarySchema = Type.Object(
  {
    totals: UsageTotalsSchema,
    scopes: Type.Array(UsageScopeSummarySchema, { maxItems: 5 }),
  },
  { additionalProperties: false },
)
export type UsageSummary = Static<typeof UsageSummarySchema>

export const CONTEXT_CATEGORIES = [
  'system',
  'user',
  'orchestration',
  'assistant',
  'toolDefinitions',
  'toolCalls',
  'toolResults',
] as const
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number]
export const ContextEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    source: Type.Optional(Type.String({ maxLength: 512 })),
    seq: Type.Optional(count),
    bytes: count,
  },
  { additionalProperties: false },
)
export type ContextEntry = Static<typeof ContextEntrySchema>
export const ContextCategorySummarySchema = Type.Object(
  {
    category: Type.Unsafe<ContextCategory>({
      type: 'string',
      enum: [...CONTEXT_CATEGORIES],
    }),
    bytes: count,
    count,
    entries: Type.Array(ContextEntrySchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
)
export const SessionContextSnapshotSchema = Type.Object(
  {
    runId: RunIdSchema,
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    sourceHash: Type.String({ minLength: 64, maxLength: 64 }),
    totalBytes: count,
    categories: Type.Array(ContextCategorySummarySchema, {
      minItems: 7,
      maxItems: 7,
    }),
    updatedAt: Type.String({ maxLength: 64 }),
  },
  { additionalProperties: false },
)
export type SessionContextSnapshot = Static<typeof SessionContextSnapshotSchema>

export const SessionUsageSnapshotSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    context: Type.Union([SessionContextSnapshotSchema, Type.Null()]),
    all: UsageSummarySchema,
    currentRun: Type.Union([
      Type.Object(
        {
          runId: RunIdSchema,
          summary: UsageSummarySchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    header: Type.Object(
      {
        main: Type.Union([
          Type.Omit(LlmUsageRecordSchema, ['raw']),
          Type.Null(),
        ]),
        totals: UsageTotalsSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type SessionUsageSnapshot = Static<typeof SessionUsageSnapshotSchema>

/** Adds only reported metrics; absent metrics remain absent instead of becoming zero. */
export function addUsageTotals(target: UsageTotals, value: UsageTotals): void {
  target.calls += value.calls
  for (const metric of USAGE_METRICS) {
    if (value[metric] !== undefined)
      target[metric] = (target[metric] ?? 0) + value[metric]
  }
}
