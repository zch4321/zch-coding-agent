import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { AgentEventSchema, TerminalEventSchema } from './agent-events'
import {
  ConfigSectionSchema,
  ConfigSetRequestSchema,
  PermissionModeSchema,
  PublicConfigSchema,
} from './config'
import {
  CallIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
} from './ids'
import { JsonValueSchema } from './json'
import {
  AGENT_EVENT_CHANNEL,
  IPC_VERSION,
  TERMINAL_EVENT_CHANNEL,
} from './channels'

export { AGENT_EVENT_CHANNEL, IPC_VERSION, TERMINAL_EVENT_CHANNEL }

export const IpcErrorSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal('INVALID_SENDER'),
      Type.Literal('INVALID_PAYLOAD'),
      Type.Literal('PAYLOAD_TOO_LARGE'),
      Type.Literal('NOT_AVAILABLE'),
      Type.Literal('PRECONDITION_FAILED'),
      Type.Literal('CONFLICT'),
      Type.Literal('NOT_FOUND'),
      Type.Literal('CANCELLED'),
      Type.Literal('SECRET_STORAGE_UNAVAILABLE'),
      Type.Literal('INTERNAL_ERROR'),
    ]),
    message: Type.String({ maxLength: 4_096 }),
    details: Type.Optional(JsonValueSchema),
  },
  { additionalProperties: false },
)
export type IpcError = Static<typeof IpcErrorSchema>

function ipcResultSchema<ValueSchema extends TSchema>(value: ValueSchema) {
  return Type.Union([
    Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        ok: Type.Literal(true),
        value,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        ok: Type.Literal(false),
        error: IpcErrorSchema,
      },
      { additionalProperties: false },
    ),
  ])
}

const EmptyPayloadSchema = Type.Object(
  { version: Type.Literal(IPC_VERSION) },
  { additionalProperties: false },
)
const AcceptedSchema = Type.Object(
  { accepted: Type.Boolean() },
  { additionalProperties: false },
)
const SkillSummarySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ maxLength: 4_096 }),
    trigger: Type.String({ maxLength: 4_096 }),
    enabled: Type.Boolean(),
    source: Type.String({ maxLength: 2_048 }),
  },
  { additionalProperties: false },
)

export const IPC_CONTRACTS = {
  'config:get': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        section: ConfigSectionSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          section: ConfigSectionSchema,
          config: PublicConfigSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  'config:set': {
    payload: ConfigSetRequestSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          config: PublicConfigSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:choose': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          path: Type.Union([
            Type.String({ minLength: 1, maxLength: 4_096 }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'session:create': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
        mode: PermissionModeSchema,
        provider: Type.Literal('deepseek'),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { sessionId: SessionIdSchema },
        { additionalProperties: false },
      ),
    ),
  },
  'session:close': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'run:start': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        message: Type.String({ minLength: 1, maxLength: 1_000_000 }),
        clientRequestId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object({ runId: RunIdSchema }, { additionalProperties: false }),
    ),
  },
  'run:interrupt': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'approval:decide': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
        callId: CallIdSchema,
        decision: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
        rememberRule: Type.Optional(JsonValueSchema),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:input': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
        data: Type.String({ maxLength: 262_144 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'window:minimize': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'window:toggle-maximize': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'window:close': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'skills:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Array(SkillSummarySchema, { maxItems: 10_000 }),
    ),
  },
  'skills:installFromUrl': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        url: Type.String({ minLength: 1, maxLength: 2_048 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          installed: Type.Boolean(),
          skill: Type.Optional(SkillSummarySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'skills:chooseAndInstallFile': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          installed: Type.Boolean(),
          skill: Type.Optional(SkillSummarySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'skills:refresh': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Array(SkillSummarySchema, { maxItems: 10_000 }),
    ),
  },
  'skills:setEnabled': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        enabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object({ updated: Type.Boolean() }, { additionalProperties: false }),
    ),
  },
} as const

export type IpcChannel = keyof typeof IPC_CONTRACTS
export type IpcPayload<Channel extends IpcChannel> = Static<
  (typeof IPC_CONTRACTS)[Channel]['payload']
>
export type IpcResult<Channel extends IpcChannel> = Static<
  (typeof IPC_CONTRACTS)[Channel]['result']
>

export const AgentEventEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(IPC_VERSION),
    event: AgentEventSchema,
  },
  { additionalProperties: false },
)
export type AgentEventEnvelope = Static<typeof AgentEventEnvelopeSchema>

export const TerminalEventEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(IPC_VERSION),
    event: TerminalEventSchema,
  },
  { additionalProperties: false },
)
export type TerminalEventEnvelope = Static<typeof TerminalEventEnvelopeSchema>
