import { Type, type Static } from '@sinclair/typebox'
import { Sha256Schema } from '../../shared/durable'
import {
  CallIdSchema,
  AgentExecutionIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
  type AgentExecutionId,
  type CallId,
  type DiagnosticId,
  type EventId,
  type RunId,
  type SessionId,
  type TerminalId,
} from '../../shared/ids'
import { JsonValueSchema, type JsonValue } from '../../shared/json'
import {
  ModelRouteSnapshotSchema,
  type ModelRouteSnapshot,
} from '../../shared/model-route'
import {
  LlmUsageRecordSchema,
  LlmUsageScopeSchema,
  type LlmUsageRecord,
} from '../../shared/usage'
import {
  CanonicalMessageKindSchema,
  PromptBuildSummarySchema,
  type PromptBuildSummary,
} from '../../shared/trace'

export const TRACE_SCHEMA_VERSION = 3 as const

const TraceBaseSchema = Type.Object({
  schemaVersion: Type.Literal(TRACE_SCHEMA_VERSION),
  seq: Type.Integer({ minimum: 1 }),
  eventId: EventIdSchema,
  ts: Type.String({ format: 'date-time' }),
})

const PromptResourceSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
)

export const TraceFailureEvidenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('http_body'),
      Type.Literal('invalid_sse'),
      Type.Literal('invalid_json'),
      Type.Literal('invalid_completion'),
    ]),
    content: Type.String({ maxLength: 262_144 }),
    observedBytes: Type.Integer({ minimum: 0 }),
    capturedBytes: Type.Integer({ minimum: 0, maximum: 262_144 }),
    truncated: Type.Boolean(),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
)
export type TraceFailureEvidence = Static<typeof TraceFailureEvidenceSchema>

export const TraceEventSchema = Type.Union([
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('session.start'),
      sessionId: SessionIdSchema,
      workspace: Type.String({ maxLength: 4_096 }),
      model: Type.String({ maxLength: 256 }),
      mode: Type.String({ maxLength: 64 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('session.end'),
      sessionId: SessionIdSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('session.mode'),
      sessionId: SessionIdSchema,
      mode: Type.String({ maxLength: 64 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('run.start'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('run.end'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      status: Type.String({ maxLength: 64 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('llm.request'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      scope: Type.Optional(LlmUsageScopeSchema),
      normalizedMessages: Type.Array(JsonValueSchema),
      providerRequest: JsonValueSchema,
      requestFields: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 256,
          uniqueItems: true,
        }),
      ),
      wireParameters: Type.Optional(JsonValueSchema),
      requestBytes: Type.Integer({ minimum: 0 }),
      prefixHash: Type.String({ maxLength: 256 }),
      promptResources: Type.Optional(
        Type.Array(PromptResourceSummarySchema, { maxItems: 32 }),
      ),
      promptBuild: Type.Optional(PromptBuildSummarySchema),
      canonicalSource: Type.Array(
        Type.Object(
          {
            seq: Type.Integer({ minimum: 1 }),
            kind: CanonicalMessageKindSchema,
            partTypes: Type.Array(
              Type.String({ minLength: 1, maxLength: 64 }),
              { minItems: 1, maxItems: 256 },
            ),
            hash: Sha256Schema,
          },
          { additionalProperties: false },
        ),
        { maxItems: 10_000 },
      ),
      modelRoute: ModelRouteSnapshotSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('llm.stream'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      providerEvent: JsonValueSchema,
      elapsedMs: Type.Number({ minimum: 0 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('llm.response'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      rawResponse: JsonValueSchema,
      normalizedTurn: JsonValueSchema,
      providerState: Type.Optional(JsonValueSchema),
      usage: JsonValueSchema,
      timing: JsonValueSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object(
      {
        type: Type.Literal('llm.failure'),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
        callId: CallIdSchema,
        agentExecutionId: Type.Optional(AgentExecutionIdSchema),
        operation: Type.String({ minLength: 1, maxLength: 64 }),
        stage: Type.String({ minLength: 1, maxLength: 64 }),
        code: Type.String({ minLength: 1, maxLength: 128 }),
        diagnosticId: Type.Optional(DiagnosticIdSchema),
        message: Type.String({ maxLength: 2_048 }),
        httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
        providerErrorCode: Type.Optional(Type.String({ maxLength: 256 })),
        retryAfterMs: Type.Optional(Type.Number({ minimum: 0 })),
        requestId: Type.Optional(Type.String({ maxLength: 512 })),
        timing: Type.Optional(JsonValueSchema),
        evidence: Type.Optional(TraceFailureEvidenceSchema),
      },
      { additionalProperties: false },
    ),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('llm.usage'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      usage: LlmUsageRecordSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('approval'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      policySignals: Type.Array(JsonValueSchema),
      mode: Type.String({ maxLength: 64 }),
      approver: Type.String({ maxLength: 64 }),
      decision: Type.String({ maxLength: 64 }),
      reason: Type.String({ maxLength: 65_536 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('tool.proposed'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      tool: Type.String({ minLength: 1, maxLength: 512 }),
      args: JsonValueSchema,
      reason: Type.String({ maxLength: 65_536 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('tool.attempt'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      tool: Type.String({ minLength: 1, maxLength: 512 }),
      stage: Type.Union([
        Type.Literal('validation'),
        Type.Literal('permission'),
        Type.Literal('execution'),
      ]),
      outcome: Type.Union([
        Type.Literal('rejected'),
        Type.Literal('succeeded'),
        Type.Literal('failed'),
        Type.Literal('denied'),
        Type.Literal('cancelled'),
        Type.Literal('timeout'),
      ]),
      effects: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
      }),
      durationMs: Type.Number({ minimum: 0 }),
      inputBytes: Type.Integer({ minimum: 0 }),
      outputBytes: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
      errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('tool.call'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      tool: Type.String({ maxLength: 512 }),
      args: JsonValueSchema,
      reason: Type.Optional(Type.String({ maxLength: 65_536 })),
      result: JsonValueSchema,
      approvedBy: Type.String({ maxLength: 64 }),
      policySignals: Type.Array(JsonValueSchema, { maxItems: 256 }),
      durationMs: Type.Number({ minimum: 0 }),
      totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
      truncated: Type.Optional(Type.Boolean()),
      discardedHash: Type.Optional(Type.String({ maxLength: 256 })),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('terminal.event'),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      direction: Type.Union([
        Type.Literal('input'),
        Type.Literal('output'),
        Type.Literal('status'),
      ]),
      data: JsonValueSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('user.message'),
      sessionId: SessionIdSchema,
      runId: Type.Optional(RunIdSchema),
      text: Type.String({ maxLength: 1_000_000 }),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('agent.message'),
      sessionId: SessionIdSchema,
      runId: Type.Optional(RunIdSchema),
      text: Type.String({ maxLength: 1_000_000 }),
      reasoning: Type.Optional(Type.String({ maxLength: 1_000_000 })),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('orchestrator.message'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      kind: Type.String({ maxLength: 128 }),
      text: Type.String({ maxLength: 1_000_000 }),
      promptId: Type.Optional(Type.String({ maxLength: 256 })),
      promptHash: Type.Optional(Type.String({ maxLength: 128 })),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('plan.status'),
      sessionId: SessionIdSchema,
      previousStatus: Type.String({ maxLength: 64 }),
      status: Type.String({ maxLength: 64 }),
      source: Type.String({ maxLength: 128 }),
      plan: JsonValueSchema,
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('interjection.message'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      interjectionId: Type.String({ maxLength: 128 }),
      status: Type.String({ maxLength: 64 }),
      content: Type.String({ maxLength: 1_000_000 }),
      injectedAfterToolBatchId: Type.Optional(Type.String({ maxLength: 128 })),
      createdAt: Type.String({ format: 'date-time' }),
    }),
  ]),
])

export type TraceEvent = Static<typeof TraceEventSchema>

interface TraceInputBase {
  sessionId: SessionId
}

export type TraceEventInput =
  | (TraceInputBase & {
      type: 'session.start'
      workspace: string
      model: string
      mode: string
    })
  | (TraceInputBase & { type: 'session.end'; reason?: string })
  | (TraceInputBase & { type: 'session.mode'; mode: string })
  | (TraceInputBase & { type: 'run.start'; runId: RunId })
  | (TraceInputBase & {
      type: 'run.end'
      runId: RunId
      status: string
    })
  | (TraceInputBase & {
      type: 'llm.request'
      runId: RunId
      callId: CallId
      scope?: LlmUsageRecord['scope']
      normalizedMessages: JsonValue[]
      providerRequest: JsonValue
      requestFields: string[]
      wireParameters: JsonValue
      requestBytes: number
      prefixHash: string
      promptResources?: Static<typeof PromptResourceSummarySchema>[]
      promptBuild?: PromptBuildSummary
      canonicalSource: Array<{
        seq: number
        kind: Static<typeof CanonicalMessageKindSchema>
        partTypes: string[]
        hash: string
      }>
      modelRoute: ModelRouteSnapshot
    })
  | (TraceInputBase & {
      type: 'llm.response'
      runId: RunId
      callId: CallId
      rawResponse: JsonValue
      normalizedTurn: JsonValue
      providerState?: JsonValue
      usage: JsonValue
      timing: JsonValue
    })
  | (TraceInputBase & {
      type: 'llm.failure'
      runId: RunId
      callId: CallId
      agentExecutionId?: AgentExecutionId
      operation: string
      stage: string
      code: string
      diagnosticId?: DiagnosticId
      message: string
      httpStatus?: number
      providerErrorCode?: string
      retryAfterMs?: number
      requestId?: string
      timing?: JsonValue
      evidence?: TraceFailureEvidence
    })
  | (TraceInputBase & {
      type: 'llm.usage'
      runId: RunId
      callId: CallId
      usage: LlmUsageRecord
    })
  | (TraceInputBase & {
      type: 'approval'
      runId: RunId
      callId: CallId
      policySignals: JsonValue[]
      mode: string
      approver: string
      decision: string
      reason: string
    })
  | (TraceInputBase & {
      type: 'tool.proposed'
      runId: RunId
      callId: CallId
      tool: string
      args: JsonValue
      reason: string
    })
  | (TraceInputBase & {
      type: 'tool.attempt'
      runId: RunId
      callId: CallId
      tool: string
      stage: 'validation' | 'permission' | 'execution'
      outcome:
        | 'rejected'
        | 'succeeded'
        | 'failed'
        | 'denied'
        | 'cancelled'
        | 'timeout'
      effects: string[]
      durationMs: number
      inputBytes: number
      outputBytes: number
      truncated: boolean
      errorCode?: string
    })
  | (TraceInputBase & {
      type: 'tool.call'
      runId: RunId
      callId: CallId
      tool: string
      args: JsonValue
      reason?: string
      result: JsonValue
      approvedBy: string
      policySignals: JsonValue[]
      durationMs: number
      totalBytes?: number
      truncated?: boolean
      discardedHash?: string
    })
  | (TraceInputBase & {
      type: 'terminal.event'
      terminalId: TerminalId
      direction: 'input' | 'output' | 'status'
      data: JsonValue
    })
  | (TraceInputBase & {
      type: 'user.message'
      runId?: RunId
      text: string
    })
  | (TraceInputBase & {
      type: 'agent.message'
      runId?: RunId
      text: string
      reasoning?: string
    })
  | (TraceInputBase & {
      type: 'orchestrator.message'
      runId: RunId
      kind: string
      text: string
      promptId?: string
      promptHash?: string
    })
  | (TraceInputBase & {
      type: 'plan.status'
      previousStatus: string
      status: string
      source: string
      plan: JsonValue
    })
  | (TraceInputBase & {
      type: 'interjection.message'
      runId: RunId
      interjectionId: string
      status: string
      content: string
      injectedAfterToolBatchId?: string
      createdAt: string
    })

export interface TraceEventFactory {
  next(input: TraceEventInput): TraceEvent
}

/** Creates a schema-validated trace event with stable sequence, ID, and timestamp fields. */
export function createTraceEvent(
  input: TraceEventInput,
  seq: number,
  eventId: EventId,
  ts = new Date().toISOString(),
): TraceEvent {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    seq,
    eventId,
    ts,
    ...input,
  } as TraceEvent
}
