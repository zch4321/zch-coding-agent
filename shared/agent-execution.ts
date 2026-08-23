import { Type, type Static } from '@sinclair/typebox'
import { RunStatusSchema, ToolResultEnvelopeSchema } from './agent-events'
import {
  DateTimeSchema,
  MAX_MESSAGE_PAGE_RECORDS,
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_RUNTIME_TEXT_LENGTH,
  MAX_RUNTIME_TOOL_RECORDS,
  MessageSeqSchema,
} from './durable'
import {
  AgentExecutionIdSchema,
  CallIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from './ids'
import { JsonValueSchema } from './json'
import { ToolResultPartSchema } from './message'
import { LlmUsageRecordSchema } from './usage'

export const MAX_AGENT_EXECUTION_PAGE_RECORDS = 100

export const AgentExecutionKindSchema = Type.Union([
  Type.Literal('subagent'),
  Type.Literal('swarm'),
])
export type AgentExecutionKind = Static<typeof AgentExecutionKindSchema>

export const AgentExecutionStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('preparing'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('partial'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed_out'),
  Type.Literal('interrupted'),
])
export type AgentExecutionStatus = Static<typeof AgentExecutionStatusSchema>

export const AgentExecutionUsageSummarySchema = Type.Object(
  {
    records: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    promptTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    completionTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    reasoningTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    totalTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    cacheHitTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    cacheMissTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  },
  { additionalProperties: false },
)
export type AgentExecutionUsageSummary = Static<
  typeof AgentExecutionUsageSummarySchema
>

export const AgentExecutionCountsSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0, maximum: 32 }),
    queued: Type.Integer({ minimum: 0, maximum: 32 }),
    running: Type.Integer({ minimum: 0, maximum: 32 }),
    completed: Type.Integer({ minimum: 0, maximum: 32 }),
    failed: Type.Integer({ minimum: 0, maximum: 32 }),
  },
  { additionalProperties: false },
)
export type AgentExecutionCounts = Static<typeof AgentExecutionCountsSchema>

export const AgentExecutionSummarySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: AgentExecutionIdSchema,
    kind: AgentExecutionKindSchema,
    parentSessionId: SessionIdSchema,
    parentRunId: RunIdSchema,
    parentCallId: CallIdSchema,
    parentExecutionId: Type.Optional(AgentExecutionIdSchema),
    childOrdinal: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    status: AgentExecutionStatusSchema,
    providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    usage: Type.Optional(AgentExecutionUsageSummarySchema),
    agentCounts: Type.Optional(AgentExecutionCountsSchema),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 128 }),
          message: Type.String({ maxLength: 65_536 }),
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    completedAt: Type.Optional(DateTimeSchema),
  },
  { additionalProperties: false },
)
export type AgentExecutionSummary = Static<typeof AgentExecutionSummarySchema>

export const AgentExecutionListCursorSchema = Type.Object(
  {
    createdAt: DateTimeSchema,
    executionId: AgentExecutionIdSchema,
  },
  { additionalProperties: false },
)
export type AgentExecutionListCursor = Static<
  typeof AgentExecutionListCursorSchema
>

export const AgentExecutionSummaryPageSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    records: Type.Array(AgentExecutionSummarySchema, {
      maxItems: MAX_AGENT_EXECUTION_PAGE_RECORDS,
    }),
    hasMore: Type.Boolean(),
    nextBefore: Type.Optional(AgentExecutionListCursorSchema),
  },
  { additionalProperties: false },
)
export type AgentExecutionSummaryPage = Static<
  typeof AgentExecutionSummaryPageSchema
>

const ActivityBaseProperties = {
  id: Type.String({ minLength: 1, maxLength: 256 }),
  seq: MessageSeqSchema,
  ordinal: Type.Integer({ minimum: 0, maximum: 1_024 }),
}

export const AgentExecutionActivitySchema = Type.Union([
  Type.Object(
    {
      ...ActivityBaseProperties,
      type: Type.Literal('reasoning'),
      text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_TEXT_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ActivityBaseProperties,
      type: Type.Literal('message'),
      text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_TEXT_LENGTH }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ActivityBaseProperties,
      type: Type.Literal('tool'),
      callId: CallIdSchema,
      tool: Type.String({ minLength: 1, maxLength: 512 }),
      args: JsonValueSchema,
      reason: Type.String({ maxLength: 65_536 }),
      status: Type.Union([Type.Literal('proposed'), Type.Literal('completed')]),
      result: Type.Optional(
        Type.Union([ToolResultPartSchema, ToolResultEnvelopeSchema]),
      ),
    },
    { additionalProperties: false },
  ),
])
export type AgentExecutionActivity = Static<typeof AgentExecutionActivitySchema>

export const AgentExecutionActivityPageSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    records: Type.Array(AgentExecutionActivitySchema, {
      maxItems: MAX_MESSAGE_PAGE_RECORDS * (MAX_MESSAGE_PARTS + 1),
    }),
    hasMore: Type.Boolean(),
    nextBeforeSeq: Type.Optional(MessageSeqSchema),
  },
  { additionalProperties: false },
)
export type AgentExecutionActivityPage = Static<
  typeof AgentExecutionActivityPageSchema
>

export const AgentExecutionStatisticsSchema = Type.Object(
  {
    toolCallCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type AgentExecutionStatistics = Static<
  typeof AgentExecutionStatisticsSchema
>

export const AgentExecutionLiveOverlaySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    status: RunStatusSchema,
    text: Type.String({ maxLength: MAX_RUNTIME_TEXT_LENGTH }),
    reasoning: Type.String({ maxLength: MAX_RUNTIME_TEXT_LENGTH }),
    tools: Type.Array(
      Type.Object(
        {
          callId: CallIdSchema,
          tool: Type.String({ minLength: 1, maxLength: 512 }),
          args: JsonValueSchema,
          reason: Type.String({ maxLength: 65_536 }),
          status: Type.Union([
            Type.Literal('proposed'),
            Type.Literal('completed'),
          ]),
          result: Type.Optional(ToolResultEnvelopeSchema),
        },
        { additionalProperties: false },
      ),
      { maxItems: MAX_RUNTIME_TOOL_RECORDS },
    ),
  },
  { additionalProperties: false },
)
export type AgentExecutionLiveOverlay = Static<
  typeof AgentExecutionLiveOverlaySchema
>

export const AgentExecutionDetailSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    summary: AgentExecutionSummarySchema,
    task: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_MESSAGE_TEXT_LENGTH }),
    ),
    statistics: AgentExecutionStatisticsSchema,
    children: Type.Optional(
      Type.Array(AgentExecutionSummarySchema, { maxItems: 32 }),
    ),
    activityPage: AgentExecutionActivityPageSchema,
    live: Type.Optional(AgentExecutionLiveOverlaySchema),
  },
  { additionalProperties: false },
)
export type AgentExecutionDetail = Static<typeof AgentExecutionDetailSchema>

const AgentExecutionEventBaseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ts: DateTimeSchema,
  executionId: AgentExecutionIdSchema,
  parentSessionId: SessionIdSchema,
  parentRunId: RunIdSchema,
  parentCallId: CallIdSchema,
})

export const AgentExecutionEventSchema = Type.Union([
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('execution.changed'),
        summary: AgentExecutionSummarySchema,
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('run.status'),
        status: RunStatusSchema,
        error: Type.Optional(
          Type.Object(
            {
              code: Type.String({ minLength: 1, maxLength: 128 }),
              message: Type.String({ maxLength: 65_536 }),
            },
            { additionalProperties: false },
          ),
        ),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('assistant.stream.reset'),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('assistant.text.delta'),
        delta: Type.String({ maxLength: 65_536 }),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('assistant.reasoning.delta'),
        delta: Type.String({ maxLength: 65_536 }),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('assistant.message.completed'),
        text: Type.String({ maxLength: MAX_MESSAGE_TEXT_LENGTH }),
        reasoning: Type.Optional(
          Type.String({ maxLength: MAX_MESSAGE_TEXT_LENGTH }),
        ),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('tool.proposed'),
        callId: CallIdSchema,
        tool: Type.String({ minLength: 1, maxLength: 512 }),
        args: JsonValueSchema,
        reason: Type.String({ maxLength: 65_536 }),
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('tool.completed'),
        callId: CallIdSchema,
        result: ToolResultEnvelopeSchema,
      }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      AgentExecutionEventBaseSchema,
      Type.Object({
        type: Type.Literal('llm.usage'),
        callId: CallIdSchema,
        usage: LlmUsageRecordSchema,
      }),
    ],
    { additionalProperties: false },
  ),
])
export type AgentExecutionEvent = Static<typeof AgentExecutionEventSchema>

export type AgentExecutionEventDraft = AgentExecutionEvent extends infer Event
  ? Event extends AgentExecutionEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never

export const AgentExecutionEventEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(1),
    event: AgentExecutionEventSchema,
  },
  { additionalProperties: false },
)
export type AgentExecutionEventEnvelope = Static<
  typeof AgentExecutionEventEnvelopeSchema
>
