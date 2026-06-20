import { Type, type Static } from '@sinclair/typebox'
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

const TraceBaseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  seq: Type.Integer({ minimum: 1 }),
  eventId: EventIdSchema,
  ts: Type.String({ format: 'date-time' }),
})

export const TraceEventSchema = Type.Union([
  Type.Composite([
    TraceBaseSchema,
    Type.Object({
      type: Type.Literal('session.start'),
      sessionId: SessionIdSchema,
      workspace: Type.String({ maxLength: 4_096 }),
      model: Type.String({ maxLength: 256 }),
      mode: Type.String({ maxLength: 64 }),
      forkedFromEventId: Type.Optional(EventIdSchema),
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
      normalizedMessages: Type.Array(JsonValueSchema),
      providerRequest: JsonValueSchema,
      requestBytes: Type.Integer({ minimum: 0 }),
      prefixHash: Type.String({ maxLength: 256 }),
      prefixFingerprints: Type.Optional(
        Type.Array(Type.String({ maxLength: 256 })),
      ),
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
      type: Type.Literal('tool.call'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      tool: Type.String({ maxLength: 128 }),
      args: JsonValueSchema,
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
      forkedFromEventId?: EventId
    })
  | (TraceInputBase & { type: 'session.end' })
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
      normalizedMessages: JsonValue[]
      providerRequest: JsonValue
      requestBytes: number
      prefixHash: string
      prefixFingerprints?: string[]
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
      type: 'tool.call'
      runId: RunId
      callId: CallId
      tool: string
      args: JsonValue
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
    schemaVersion: 1,
    seq,
    eventId,
    ts,
    ...input,
  } as TraceEvent
}
