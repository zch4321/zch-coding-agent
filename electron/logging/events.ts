import { Type, type Static } from '@sinclair/typebox'
import { Sha256Schema } from '../../shared/durable'
import {
  CallIdSchema,
  EventIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
  type CallId,
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

export const TRACE_SCHEMA_VERSION = 2 as const

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
      type: Type.Literal('run.rejected'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      reason: Type.Union([
        Type.Literal('max_concurrent_runs'),
        Type.Literal('workspace_writer_active'),
      ]),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      active: Type.Optional(Type.Integer({ minimum: 0, maximum: 32 })),
      writerSessionId: Type.Optional(SessionIdSchema),
      writerRunId: Type.Optional(RunIdSchema),
    }),
  ]),
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('workspace.writer'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
      status: Type.Union([
        Type.Literal('acquired'),
        Type.Literal('released'),
        Type.Literal('rejected'),
      ]),
      writerSessionId: Type.Optional(SessionIdSchema),
      writerRunId: Type.Optional(RunIdSchema),
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
      requestBytes: Type.Integer({ minimum: 0 }),
      prefixHash: Type.String({ maxLength: 256 }),
      prefixFingerprints: Type.Optional(
        Type.Array(Type.String({ maxLength: 256 })),
      ),
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
      diffHash: Type.Optional(Type.String({ maxLength: 128 })),
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
  | (TraceInputBase & { type: 'session.end' })
  | (TraceInputBase & { type: 'session.mode'; mode: string })
  | (TraceInputBase & {
      type: 'run.rejected'
      runId: RunId
      reason: 'max_concurrent_runs' | 'workspace_writer_active'
      limit?: number
      active?: number
      writerSessionId?: SessionId
      writerRunId?: RunId
    })
  | (TraceInputBase & {
      type: 'workspace.writer'
      runId: RunId
      workspace: string
      status: 'acquired' | 'released' | 'rejected'
      writerSessionId?: SessionId
      writerRunId?: RunId
    })
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
      requestBytes: number
      prefixHash: string
      prefixFingerprints?: string[]
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
      type: 'llm.stream'
      runId: RunId
      callId: CallId
      providerEvent: JsonValue
      elapsedMs: number
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
      diffHash?: string
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
