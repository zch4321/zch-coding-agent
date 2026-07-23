import { Type, type Static } from '@sinclair/typebox'
import { Sha256Schema } from './durable'
import {
  EventIdSchema,
  MessageIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from './ids'
import { JsonValueSchema } from './json'
import {
  CANONICAL_PROMPT_KINDS,
  CanonicalMessageKindSchema,
  type CanonicalMessageKind,
} from './message'

export const TraceIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
})
export type TraceId = Static<typeof TraceIdSchema>

export const TraceInfoSchema = Type.Object(
  {
    traceId: TraceIdSchema,
    sessionId: Type.Optional(SessionIdSchema),
    conversationId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256 }),
    ),
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
    endedAt: Type.Optional(Type.String({ format: 'date-time' })),
    closed: Type.Boolean(),
    size: Type.Integer({ minimum: 0 }),
    eventCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type TraceInfo = Static<typeof TraceInfoSchema>

export { CanonicalMessageKindSchema, type CanonicalMessageKind }

export const PROMPT_LAYER_KINDS = [
  ...CANONICAL_PROMPT_KINDS,
  'compact_summary',
] as const
export type PromptLayerKind = (typeof PROMPT_LAYER_KINDS)[number]
export const PromptLayerKindSchema = Type.Unsafe<PromptLayerKind>({
  type: 'string',
  enum: [...PROMPT_LAYER_KINDS],
})

export const PromptLayerSummarySchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    messageId: MessageIdSchema,
    kind: PromptLayerKindSchema,
    source: Type.String({ minLength: 1, maxLength: 512 }),
    trusted: Type.Boolean(),
    editable: Type.Boolean(),
    sha256: Sha256Schema,
    estimatedTokens: Type.Integer({ minimum: 0 }),
    included: Type.Boolean(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type PromptLayerSummary = Static<typeof PromptLayerSummarySchema>

export const PromptBuildSummarySchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    layers: Type.Array(PromptLayerSummarySchema, { maxItems: 10_000 }),
    messageCount: Type.Integer({ minimum: 0 }),
    activeMessageCount: Type.Integer({ minimum: 0 }),
    omittedHistoryMessages: Type.Integer({ minimum: 0 }),
    promptBudgetTokens: Type.Integer({ minimum: 0 }),
    estimatedTokens: Type.Integer({ minimum: 0 }),
    toolsHash: Sha256Schema,
    sourceHash: Sha256Schema,
  },
  { additionalProperties: false },
)
export type PromptBuildSummary = Static<typeof PromptBuildSummarySchema>

export const TraceRequestSummarySchema = Type.Object(
  {
    eventId: EventIdSchema,
    runId: RunIdSchema,
    seq: Type.Integer({ minimum: 1 }),
    messages: Type.Array(JsonValueSchema, { maxItems: 10_000 }),
    promptBuild: Type.Optional(PromptBuildSummarySchema),
  },
  { additionalProperties: false },
)
export type TraceRequestSummary = Static<typeof TraceRequestSummarySchema>

export const ReplaySummarySchema = Type.Object(
  {
    traceId: TraceIdSchema,
    lastSeq: Type.Integer({ minimum: 0 }),
    skippedEvents: Type.Integer({ minimum: 0 }),
    sessionId: Type.Optional(SessionIdSchema),
    workspace: Type.Optional(Type.String({ maxLength: 4_096 })),
    model: Type.Optional(Type.String({ maxLength: 256 })),
    mode: Type.Optional(Type.String({ maxLength: 64 })),
    closed: Type.Boolean(),
    runs: Type.Array(
      Type.Object(
        {
          runId: RunIdSchema,
          status: Type.String({ maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    requests: Type.Array(TraceRequestSummarySchema, { maxItems: 10_000 }),
    messages: Type.Array(
      Type.Object(
        {
          role: Type.Union([Type.Literal('user'), Type.Literal('agent')]),
          text: Type.String({ maxLength: 200_000 }),
          reasoning: Type.Optional(Type.String({ maxLength: 200_000 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    interjections: Type.Array(
      Type.Object(
        {
          interjectionId: Type.String({ minLength: 1, maxLength: 128 }),
          status: Type.String({ maxLength: 64 }),
          content: Type.String({ maxLength: 200_000 }),
          createdAt: Type.String({ format: 'date-time' }),
          injectedAfterToolBatchId: Type.Optional(
            Type.String({ maxLength: 128 }),
          ),
          history: Type.Array(
            Type.Object(
              {
                seq: Type.Integer({ minimum: 1 }),
                status: Type.String({ maxLength: 64 }),
                content: Type.String({ maxLength: 200_000 }),
                createdAt: Type.String({ format: 'date-time' }),
                injectedAfterToolBatchId: Type.Optional(
                  Type.String({ maxLength: 128 }),
                ),
              },
              { additionalProperties: false },
            ),
            { maxItems: 10_000 },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    toolCount: Type.Integer({ minimum: 0 }),
    approvalCount: Type.Integer({ minimum: 0 }),
    terminalCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type ReplaySummary = Static<typeof ReplaySummarySchema>

const OptionalMetricSchema = Type.Union([
  Type.Number({ minimum: 0 }),
  Type.Null(),
])

export const ProviderStatsSchema = Type.Object(
  {
    requestCount: Type.Integer({ minimum: 0 }),
    requestBytes: Type.Integer({ minimum: 0 }),
    promptTokens: OptionalMetricSchema,
    completionTokens: OptionalMetricSchema,
    totalTokens: OptionalMetricSchema,
    cacheHitTokens: OptionalMetricSchema,
    cacheMissTokens: OptionalMetricSchema,
    averageTtftMs: OptionalMetricSchema,
    averageTotalMs: OptionalMetricSchema,
    prefixFingerprints: Type.Array(Type.String({ maxLength: 256 }), {
      maxItems: 10_000,
    }),
  },
  { additionalProperties: false },
)
export type ProviderStats = Static<typeof ProviderStatsSchema>

export { EventIdSchema }
