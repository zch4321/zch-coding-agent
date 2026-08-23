import { Type, type Static } from '@sinclair/typebox'
import {
  AgentExecutionIdSchema,
  CallIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  RunIdSchema,
  SessionIdSchema,
  type AgentExecutionId,
  type CallId,
  type DiagnosticId,
  type EventId,
  type RunId,
  type SessionId,
} from '../../shared/ids'
import {
  OperationalLogLevelSchema,
  type OperationalLogLevel,
} from '../../shared/config/application'

export const OPERATIONAL_LOG_SCHEMA_VERSION = 1 as const
export const OPERATIONAL_LOG_MAX_EVENT_BYTES = 32 * 1_024
export const OPERATIONAL_LOG_FILE_BYTES = 5_000_000

const OperationalRecordLevelSchema = Type.Exclude(
  OperationalLogLevelSchema,
  Type.Literal('off'),
)

export const OperationalEventNameSchema = Type.Union([
  Type.Literal('app.started'),
  Type.Literal('app.stopped'),
  Type.Literal('app.failed'),
  Type.Literal('backend.started'),
  Type.Literal('backend.stopped'),
  Type.Literal('backend.failed'),
  Type.Literal('backend.diagnostic'),
  Type.Literal('database.migration'),
  Type.Literal('log.cleanup.failed'),
  Type.Literal('ipc.failed'),
  Type.Literal('process.failed'),
  Type.Literal('run.started'),
  Type.Literal('run.completed'),
  Type.Literal('run.cancelled'),
  Type.Literal('run.rejected'),
  Type.Literal('run.failed'),
  Type.Literal('provider.started'),
  Type.Literal('provider.completed'),
  Type.Literal('provider.fallback'),
  Type.Literal('provider.failed'),
  Type.Literal('tool.batch.started'),
  Type.Literal('tool.batch.completed'),
  Type.Literal('tool.proposed'),
  Type.Literal('tool.execution.started'),
  Type.Literal('tool.execution.completed'),
  Type.Literal('tool.execution.failed'),
  Type.Literal('tool.batch.failed'),
  Type.Literal('compaction.failed'),
])
export type OperationalEventName = Static<typeof OperationalEventNameSchema>

const SerializedErrorSchema = Type.Recursive((Self) =>
  Type.Object(
    {
      name: Type.String({ maxLength: 128 }),
      message: Type.String({ maxLength: 2_048 }),
      code: Type.Optional(Type.String({ maxLength: 128 })),
      stack: Type.Optional(
        Type.Array(Type.String({ maxLength: 512 }), { maxItems: 16 }),
      ),
      cause: Type.Optional(Self),
    },
    { additionalProperties: false },
  ),
)
export type SerializedOperationalError = Static<typeof SerializedErrorSchema>

const CorrelationProperties = {
  sessionId: Type.Optional(SessionIdSchema),
  runId: Type.Optional(RunIdSchema),
  providerCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  toolBatchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  callId: Type.Optional(CallIdSchema),
  agentExecutionId: Type.Optional(AgentExecutionIdSchema),
  traceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}

export const OperationalLogRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(OPERATIONAL_LOG_SCHEMA_VERSION),
    seq: Type.Integer({ minimum: 1 }),
    eventId: EventIdSchema,
    ts: Type.String({ format: 'date-time' }),
    level: OperationalRecordLevelSchema,
    event: OperationalEventNameSchema,
    processInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    diagnosticId: Type.Optional(DiagnosticIdSchema),
    ...CorrelationProperties,
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    message: Type.Optional(Type.String({ maxLength: 2_048 })),
    error: Type.Optional(SerializedErrorSchema),
    operation: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    providerType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ maxLength: 256 })),
    reasoning: Type.Optional(Type.String({ maxLength: 32 })),
    endpoint: Type.Optional(Type.String({ maxLength: 2_048 })),
    messageCount: Type.Optional(Type.Integer({ minimum: 0 })),
    toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
    requestBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    requestFields: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
    outputTokenField: Type.Optional(Type.String({ maxLength: 64 })),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
    wireReasoningEffort: Type.Optional(Type.String({ maxLength: 32 })),
    thinkingMode: Type.Optional(Type.String({ maxLength: 32 })),
    responseBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    providerErrorCode: Type.Optional(Type.String({ maxLength: 256 })),
    retryAfterMs: Type.Optional(Type.Number({ minimum: 0 })),
    requestId: Type.Optional(Type.String({ maxLength: 512 })),
    attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    promptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    completionTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheHitTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheMissTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    toolName: Type.Optional(Type.String({ maxLength: 128 })),
    executionMode: Type.Optional(Type.String({ maxLength: 64 })),
    effects: Type.Optional(
      Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
    ),
    phase: Type.Optional(Type.String({ maxLength: 64 })),
    approval: Type.Optional(Type.String({ maxLength: 64 })),
    inputBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    outputBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    truncated: Type.Optional(Type.Boolean()),
    itemCount: Type.Optional(Type.Integer({ minimum: 0 })),
    databaseVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
)
export type OperationalLogRecord = Static<typeof OperationalLogRecordSchema>

export interface OperationalCorrelation {
  sessionId?: SessionId
  runId?: RunId
  providerCallId?: string
  toolBatchId?: string
  callId?: CallId
  agentExecutionId?: AgentExecutionId
  traceId?: string
}

export interface OperationalEventInput extends OperationalCorrelation {
  level: Exclude<OperationalLogLevel, 'off'>
  event: OperationalEventName
  diagnosticId?: DiagnosticId
  code?: string
  message?: string
  error?: unknown
  operation?: string
  outcome?: string
  providerId?: string
  providerType?: string
  model?: string
  reasoning?: string
  endpoint?: string
  messageCount?: number
  toolCount?: number
  requestBytes?: number
  requestFields?: string[]
  outputTokenField?: string
  maxOutputTokens?: number
  wireReasoningEffort?: string
  thinkingMode?: string
  responseBytes?: number
  httpStatus?: number
  providerErrorCode?: string
  retryAfterMs?: number
  requestId?: string
  attempt?: number
  maxAttempts?: number
  ttftMs?: number
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  toolName?: string
  executionMode?: string
  effects?: string[]
  phase?: string
  approval?: string
  inputBytes?: number
  outputBytes?: number
  truncated?: boolean
  itemCount?: number
  databaseVersion?: number
}

export interface OperationalLogWriteResult {
  eventId: EventId
  diagnosticId?: DiagnosticId
  written: boolean
}
