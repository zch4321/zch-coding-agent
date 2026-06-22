import { Type, type Static } from '@sinclair/typebox'
import {
  CallIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
} from './ids'
import { JsonValueSchema } from './json'
import { TerminalStatusSchema } from './terminal'
import { LlmUsageRecordSchema } from './usage'

const EventBaseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  seq: Type.Integer({ minimum: 1 }),
  ts: Type.String({ format: 'date-time' }),
})

export const RunStatusSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('calling_llm'),
  Type.Literal('evaluating_tools'),
  Type.Literal('awaiting_approval'),
  Type.Literal('running_tools'),
  Type.Literal('cancelling'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
])
export type RunStatus = Static<typeof RunStatusSchema>

export const ToolResultEnvelopeSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('ok'),
      content: JsonValueSchema,
      truncated: Type.Optional(Type.Boolean()),
      totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('error'),
      code: Type.String({ minLength: 1, maxLength: 128 }),
      message: Type.String({ maxLength: 65_536 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([
        Type.Literal('denied'),
        Type.Literal('cancelled'),
        Type.Literal('timeout'),
      ]),
      message: Type.String({ maxLength: 65_536 }),
    },
    { additionalProperties: false },
  ),
])
export type ToolResultEnvelope = Static<typeof ToolResultEnvelopeSchema>

export const PolicySignalSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    severity: Type.Union([
      Type.Literal('info'),
      Type.Literal('warning'),
      Type.Literal('danger'),
    ]),
    detail: Type.String({ maxLength: 65_536 }),
  },
  { additionalProperties: false },
)
export type PolicySignal = Static<typeof PolicySignalSchema>

export const AgentEventSchema = Type.Union([
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('run.status'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
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
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('assistant.text.delta'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      delta: Type.String({ maxLength: 65_536 }),
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('assistant.reasoning.delta'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      delta: Type.String({ maxLength: 65_536 }),
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('tool.proposed'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      tool: Type.String({ minLength: 1, maxLength: 128 }),
      args: JsonValueSchema,
      reason: Type.String({ maxLength: 65_536 }),
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('approval.requested'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      kind: Type.Union([Type.Literal('tool'), Type.Literal('context')]),
      tool: Type.String({ minLength: 1, maxLength: 128 }),
      args: JsonValueSchema,
      reason: Type.String({ maxLength: 65_536 }),
      policySignals: Type.Array(PolicySignalSchema, { maxItems: 256 }),
      diff: Type.Optional(Type.String({ maxLength: 262_144 })),
      diffHash: Type.Optional(Type.String({ maxLength: 128 })),
      rememberable: Type.Boolean(),
      rememberArgConstraints: Type.Optional(JsonValueSchema),
      expiresAt: Type.String({ format: 'date-time' }),
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('tool.completed'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      result: ToolResultEnvelopeSchema,
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('llm.usage'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      callId: CallIdSchema,
      usage: LlmUsageRecordSchema,
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('session.closed'),
      sessionId: SessionIdSchema,
    }),
  ]),
])
export type AgentEvent = Static<typeof AgentEventSchema>

export const TerminalEventSchema = Type.Union([
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('terminal.output'),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      chunk: Type.String({ maxLength: 262_144 }),
    }),
  ]),
  Type.Composite([
    EventBaseSchema,
    Type.Object({
      type: Type.Literal('terminal.status'),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      status: TerminalStatusSchema,
      exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    }),
  ]),
])
export type TerminalEvent = Static<typeof TerminalEventSchema>
