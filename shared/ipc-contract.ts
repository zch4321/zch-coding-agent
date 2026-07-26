import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { AgentEventSchema, TerminalEventSchema } from './agent-events'
import {
  ConfigSectionSchema,
  ConfigSetRequestSchema,
  PublicConfigSchema,
} from './config'
import {
  CallIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
} from './ids'
import { JsonValueSchema } from './json'
import { PlanStatusSchema } from './orchestration'
import {
  CodeBackendStatusSchema,
  DetectedProjectModulesSchema,
  ProjectMetadataSnapshotSchema,
  ProjectModelSchema,
} from './project-model'
import { TerminalInfoSchema, TerminalSnapshotSchema } from './terminal'
import { SkillListSchema, SkillSummarySchema } from './skills'
import { McpServerIdSchema, McpSettingsSnapshotSchema } from './mcp'
import {
  ContextAttachmentChipSchema,
  ContextAttachmentKindSchema,
} from './context'
import {
  EventIdSchema,
  ProviderStatsSchema,
  ReplaySummarySchema,
  TraceIdSchema,
  TraceInfoSchema,
} from './trace'
import {
  DOMAIN_STATE_API_CONTRACTS,
  DomainStateEventSchema,
} from './domain-state-api'
import {
  SessionTranscriptPageSchema,
  SessionTranscriptRequestMessagesPageSchema,
} from './session-transcript'
import {
  APP_NOTIFICATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  DOMAIN_STATE_EVENT_CHANNEL,
  IPC_VERSION,
  TERMINAL_EVENT_CHANNEL,
} from './channels'
export {
  BackendNotificationEnvelopeSchema,
  type BackendNotificationEnvelope,
} from './notifications'

export {
  APP_NOTIFICATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  DOMAIN_STATE_EVENT_CHANNEL,
  IPC_VERSION,
  TERMINAL_EVENT_CHANNEL,
}

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
      Type.Literal('RESOURCE_CHANGED'),
      Type.Literal('PERSISTENCE_FAILURE'),
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

function domainIpcContract<
  PayloadSchema extends TSchema,
  ResultSchema extends TSchema,
>(contract: { payload: PayloadSchema; result: ResultSchema }) {
  return {
    payload: contract.payload,
    result: ipcResultSchema(contract.result),
  }
}

const EmptyPayloadSchema = Type.Object(
  { version: Type.Literal(IPC_VERSION) },
  { additionalProperties: false },
)
const AcceptedSchema = Type.Object(
  { accepted: Type.Boolean() },
  { additionalProperties: false },
)
const ModelProfileSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    ownedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    availability: Type.Union([
      Type.Literal('provider'),
      Type.Literal('custom'),
    ]),
    capabilitySource: Type.Union([
      Type.Literal('override'),
      Type.Literal('builtin'),
      Type.Literal('default'),
    ]),
    contextWindowTokens: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
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
          warnings: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
              maxItems: 512,
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'mcp:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:reload': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:trust-enable': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        serverId: McpServerIdSchema,
        fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:disable': {
    payload: Type.Object(
      { version: Type.Literal(IPC_VERSION), serverId: McpServerIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:restart': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        serverId: McpServerIdSchema,
        workspace: Type.Optional(
          Type.String({ minLength: 1, maxLength: 4_096 }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'provider:list-models': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        refresh: Type.Boolean(),
        providerId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 128 }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          models: Type.Array(ModelProfileSchema, { maxItems: 1_000 }),
          fetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
          stale: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'app:get-bootstrap': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['app:get-bootstrap'],
  ),
  'project:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['project:list']),
  'project:add': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['project:add']),
  'project:update': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['project:update'],
  ),
  'project:remove': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['project:remove'],
  ),
  'session:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:list']),
  'session:get': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:get']),
  'session:update': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:update'],
  ),
  'session:archive': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:archive'],
  ),
  'session:restore': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:restore'],
  ),
  'session:delete': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:delete'],
  ),
  'session:fork': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:fork']),
  'session:rewind': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:rewind'],
  ),
  'session:search': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:search'],
  ),
  'message:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['message:list']),
  'message:search': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['message:search'],
  ),
  'file-change:list': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['file-change:list'],
  ),
  'file-change:revert': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['file-change:revert'],
  ),
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
  'workspace:list-directory': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
          entries: Type.Array(
            Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 4_096 }),
                name: Type.String({ minLength: 1, maxLength: 1_024 }),
                type: Type.Union([
                  Type.Literal('file'),
                  Type.Literal('directory'),
                ]),
              },
              { additionalProperties: false },
            ),
            { maxItems: 1_000 },
          ),
          truncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:read-file': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
          content: Type.String({ maxLength: 500_000 }),
          totalBytes: Type.Integer({ minimum: 0 }),
          truncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:open-file': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:choose-context': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        kind: ContextAttachmentKindSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          attachments: Type.Array(ContextAttachmentChipSchema, {
            maxItems: 32,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'project:get': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProjectMetadataSnapshotSchema),
  },
  'project:save': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        project: ProjectModelSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProjectMetadataSnapshotSchema),
  },
  'project:detect-modules': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(DetectedProjectModulesSchema),
  },
  'project:backend-status': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          statuses: Type.Array(CodeBackendStatusSchema, { maxItems: 32 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'project:restart-backend': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        backendId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(CodeBackendStatusSchema),
  },
  'plan:update-status': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        status: PlanStatusSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      DOMAIN_STATE_API_CONTRACTS['session:update'].result,
    ),
  },
  'run:start': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['run:start']),
  'run:retry': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['run:retry']),
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
  'run:interject': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
        message: Type.String({ minLength: 1, maxLength: 1_000_000 }),
        clientRequestId: Type.String({ minLength: 1, maxLength: 128 }),
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
        remember: Type.Optional(
          Type.Object(
            {
              workspaceScope: Type.Union([
                Type.Literal('workspace'),
                Type.Literal('global'),
              ]),
              expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
            },
            { additionalProperties: false },
          ),
        ),
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
  'terminal:open': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 1_000 })),
        rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { terminal: TerminalInfoSchema },
        { additionalProperties: false },
      ),
    ),
  },
  'terminal:list': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { terminals: Type.Array(TerminalInfoSchema, { maxItems: 128 }) },
        { additionalProperties: false },
      ),
    ),
  },
  'terminal:resize': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
        cols: Type.Integer({ minimum: 2, maximum: 1_000 }),
        rows: Type.Integer({ minimum: 1, maximum: 1_000 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:close': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:snapshot': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(TerminalSnapshotSchema),
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
    result: ipcResultSchema(SkillListSchema),
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
    result: ipcResultSchema(SkillListSchema),
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
  'trace:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(Type.Array(TraceInfoSchema, { maxItems: 1_000 })),
  },
  'trace:replay': {
    payload: Type.Object(
      { version: Type.Literal(IPC_VERSION), traceId: TraceIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ReplaySummarySchema),
  },
  'trace:transcript-page': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(SessionTranscriptPageSchema),
  },
  'trace:request-messages': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        requestEventId: EventIdSchema,
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(SessionTranscriptRequestMessagesPageSchema),
  },
  'trace:export-transcript': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        confirmed: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          canceled: Type.Boolean(),
          path: Type.Optional(Type.String({ maxLength: 4_096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'trace:stats': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: Type.Optional(TraceIdSchema),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProviderStatsSchema),
  },
  'logs:open-directory': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'logs:clear-closed': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        { deleted: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
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

export const DomainStateDeliverySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('commit'),
      event: DomainStateEventSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('buffer_overflow') },
    { additionalProperties: false },
  ),
])
export type DomainStateDelivery = Static<typeof DomainStateDeliverySchema>
