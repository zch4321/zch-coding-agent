import { Type, type Static } from '@sinclair/typebox'
import {
  PolicySignalSchema,
  ProviderRetryStateSchema,
  RunStatusSchema,
  ToolResultEnvelopeSchema,
} from './agent-events'
import {
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_RUNTIME_INTERJECTIONS,
  MAX_RUNTIME_TEXT_LENGTH,
  MAX_RUNTIME_TOOL_RECORDS,
} from './durable'
import { CallIdSchema, RunIdSchema, SessionIdSchema } from './ids'
import { JsonValueSchema } from './json'
import { TodoStateSchema } from './todo'

export const ActiveRunToolSnapshotSchema = Type.Object(
  {
    callId: CallIdSchema,
    tool: Type.String({ minLength: 1, maxLength: 512 }),
    status: Type.Union([
      Type.Literal('proposed'),
      Type.Literal('awaiting_approval'),
      Type.Literal('running'),
      Type.Literal('completed'),
    ]),
    arguments: Type.Optional(JsonValueSchema),
    result: Type.Optional(ToolResultEnvelopeSchema),
  },
  { additionalProperties: false },
)
export type ActiveRunToolSnapshot = Static<typeof ActiveRunToolSnapshotSchema>

export const ActiveRunApprovalSnapshotSchema = Type.Object(
  {
    callId: CallIdSchema,
    kind: Type.Union([Type.Literal('tool'), Type.Literal('context')]),
    tool: Type.String({ minLength: 1, maxLength: 512 }),
    arguments: JsonValueSchema,
    reason: Type.String({ maxLength: 65_536 }),
    policySignals: Type.Array(PolicySignalSchema, { maxItems: 256 }),
    rememberable: Type.Boolean(),
    rememberArgConstraints: Type.Optional(JsonValueSchema),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type ActiveRunApprovalSnapshot = Static<
  typeof ActiveRunApprovalSnapshotSchema
>

export const ActiveRunInterjectionSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('injected'),
      Type.Literal('superseded'),
    ]),
    content: Type.String({ maxLength: MAX_MESSAGE_TEXT_LENGTH }),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)

export const ActiveRunPublicSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    status: RunStatusSchema,
    text: Type.String({ maxLength: MAX_RUNTIME_TEXT_LENGTH }),
    reasoning: Type.String({ maxLength: MAX_RUNTIME_TEXT_LENGTH }),
    providerRetry: Type.Optional(ProviderRetryStateSchema),
    tools: Type.Array(ActiveRunToolSnapshotSchema, {
      maxItems: MAX_RUNTIME_TOOL_RECORDS,
    }),
    approval: Type.Optional(ActiveRunApprovalSnapshotSchema),
    interjections: Type.Array(ActiveRunInterjectionSnapshotSchema, {
      maxItems: MAX_RUNTIME_INTERJECTIONS,
    }),
    todo: Type.Optional(TodoStateSchema),
  },
  { additionalProperties: false },
)
export type ActiveRunPublicSnapshot = Static<
  typeof ActiveRunPublicSnapshotSchema
>
