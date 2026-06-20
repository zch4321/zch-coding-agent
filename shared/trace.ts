import { Type, type Static } from '@sinclair/typebox'
import { EventIdSchema, RunIdSchema, SessionIdSchema } from './ids'

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
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
    endedAt: Type.Optional(Type.String({ format: 'date-time' })),
    closed: Type.Boolean(),
    size: Type.Integer({ minimum: 0 }),
    eventCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type TraceInfo = Static<typeof TraceInfoSchema>

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
    forkPoints: Type.Array(
      Type.Object(
        {
          eventId: EventIdSchema,
          runId: RunIdSchema,
          seq: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
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
