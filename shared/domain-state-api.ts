import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { IPC_VERSION } from './channels'
import { PermissionModeSchema } from './config'
import {
  BackendEventSequenceSchema,
  DurableSchemaVersionSchema,
  MAX_BOOTSTRAP_SESSION_RECORDS,
  MAX_COMMIT_MESSAGE_RECORDS,
  MAX_FILE_CHANGE_RECORDS,
  MAX_MESSAGE_PAGE_RECORDS,
  MAX_PATH_LENGTH,
  MAX_PROJECT_RECORDS,
  MAX_SESSION_LIST_RECORDS,
  MessageSeqSchema,
  RevisionSchema,
} from './durable'
import { FileChangeSummarySchema } from './file-change'
import { FileChangeIdSchema, ProjectIdSchema, SessionIdSchema } from './ids'
import { MessagePageSchema, MessageRecordSchema } from './message'
import { ModelSelectionSchema } from './model-route'
import { ProjectRecordSchema } from './project'
import {
  SessionLifecycleSchema,
  SessionListCursorSchema,
  SessionPageSchema,
  SessionRecordSchema,
  SessionSnapshotSchema,
} from './session'

const versionProperty = { version: Type.Literal(IPC_VERSION) }

export const BackendEventCursorSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    backendInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    sequence: BackendEventSequenceSchema,
  },
  { additionalProperties: false },
)
export type BackendEventCursor = Static<typeof BackendEventCursorSchema>

export const ProjectCommittedChangeSchema = Type.Object(
  {
    projects: Type.Array(ProjectRecordSchema, {
      maxItems: MAX_PROJECT_RECORDS,
    }),
  },
  { additionalProperties: false },
)
export type ProjectCommittedChange = Static<typeof ProjectCommittedChangeSchema>

export const SessionMessageChangeSchema = Type.Union([
  Type.Object({ mode: Type.Literal('none') }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal('upsert'),
      records: Type.Array(MessageRecordSchema, {
        minItems: 1,
        maxItems: MAX_COMMIT_MESSAGE_RECORDS,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      // The records remain append-only. This mode tells renderer replicas to
      // discard cached pages through the compacted boundary and query a fresh
      // active-history page; it does not delete durable message records.
      mode: Type.Literal('invalidate'),
      throughSeq: MessageSeqSchema,
    },
    { additionalProperties: false },
  ),
])
export type SessionMessageChange = Static<typeof SessionMessageChangeSchema>

export const SessionCommittedChangeSchema = Type.Object(
  {
    session: SessionRecordSchema,
    messageChange: SessionMessageChangeSchema,
  },
  { additionalProperties: false },
)
export type SessionCommittedChange = Static<typeof SessionCommittedChangeSchema>

export const FileChangeCommittedChangeSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    fileChanges: Type.Array(FileChangeSummarySchema, {
      maxItems: MAX_FILE_CHANGE_RECORDS,
    }),
  },
  { additionalProperties: false },
)
export type FileChangeCommittedChange = Static<
  typeof FileChangeCommittedChangeSchema
>

export const ProjectCommitEnvelopeSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    cursor: BackendEventCursorSchema,
    topic: Type.Literal('project.changed'),
    change: ProjectCommittedChangeSchema,
  },
  { additionalProperties: false },
)

export const SessionCommitEnvelopeSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    cursor: BackendEventCursorSchema,
    topic: Type.Literal('session.changed'),
    change: SessionCommittedChangeSchema,
  },
  { additionalProperties: false },
)

export const FileChangeCommitEnvelopeSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    cursor: BackendEventCursorSchema,
    topic: Type.Literal('file-change.changed'),
    change: FileChangeCommittedChangeSchema,
  },
  { additionalProperties: false },
)

export const DurableCommitEnvelopeSchema = Type.Union([
  ProjectCommitEnvelopeSchema,
  SessionCommitEnvelopeSchema,
  FileChangeCommitEnvelopeSchema,
])
export type DurableCommitEnvelope = Static<typeof DurableCommitEnvelopeSchema>
export type DurableCommitTopic = DurableCommitEnvelope['topic']
export type DurableCommitFor<Topic extends DurableCommitTopic> = Extract<
  DurableCommitEnvelope,
  { topic: Topic }
>
export type DurableCommandResult<
  Topic extends DurableCommitTopic = DurableCommitTopic,
> = {
  version: typeof IPC_VERSION
  commit: DurableCommitFor<Topic>
}

function commandResultSchema<CommitSchema extends TSchema>(
  commit: CommitSchema,
) {
  return Type.Object(
    { ...versionProperty, commit },
    { additionalProperties: false },
  )
}

export const ProjectCommandResultSchema = commandResultSchema(
  ProjectCommitEnvelopeSchema,
)
export type ProjectCommandResult = Static<typeof ProjectCommandResultSchema>

export const SessionCommandResultSchema = commandResultSchema(
  SessionCommitEnvelopeSchema,
)
export type SessionCommandResult = Static<typeof SessionCommandResultSchema>

export const FileChangeCommandResultSchema = commandResultSchema(
  FileChangeCommitEnvelopeSchema,
)
export type FileChangeCommandResult = Static<
  typeof FileChangeCommandResultSchema
>

export const DomainStateEventSchema = Type.Object(
  {
    ...versionProperty,
    commit: DurableCommitEnvelopeSchema,
  },
  { additionalProperties: false },
)
export type DomainStateEvent = Static<typeof DomainStateEventSchema>

export const AppBootstrapPayloadSchema = Type.Object(versionProperty, {
  additionalProperties: false,
})
export const AppBootstrapResultSchema = Type.Object(
  {
    ...versionProperty,
    cursor: BackendEventCursorSchema,
    projects: Type.Array(ProjectRecordSchema, {
      maxItems: MAX_PROJECT_RECORDS,
    }),
    sessions: Type.Array(SessionRecordSchema, {
      maxItems: MAX_BOOTSTRAP_SESSION_RECORDS,
    }),
  },
  { additionalProperties: false },
)

export const ProjectListPayloadSchema = Type.Object(versionProperty, {
  additionalProperties: false,
})
export const ProjectListResultSchema = Type.Object(
  {
    ...versionProperty,
    projects: Type.Array(ProjectRecordSchema, {
      maxItems: MAX_PROJECT_RECORDS,
    }),
  },
  { additionalProperties: false },
)

export const ProjectAddPayloadSchema = Type.Object(
  {
    ...versionProperty,
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
)

export const ProjectUpdatePatchSchema = Type.Union([
  Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 256 }),
      path: Type.Optional(
        Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }),
      ),
    },
    { additionalProperties: false },
  ),
])

export const ProjectUpdatePayloadSchema = Type.Object(
  {
    ...versionProperty,
    projectId: ProjectIdSchema,
    expectedRevision: RevisionSchema,
    patch: ProjectUpdatePatchSchema,
  },
  { additionalProperties: false },
)

export const ProjectRemovePayloadSchema = Type.Object(
  {
    ...versionProperty,
    projectId: ProjectIdSchema,
    expectedRevision: RevisionSchema,
  },
  { additionalProperties: false },
)

export const SessionListPayloadSchema = Type.Object(
  {
    ...versionProperty,
    projectId: Type.Optional(ProjectIdSchema),
    lifecycle: Type.Optional(SessionLifecycleSchema),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    before: Type.Optional(SessionListCursorSchema),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_SESSION_LIST_RECORDS }),
    ),
  },
  { additionalProperties: false },
)
export const SessionListResultSchema = Type.Object(
  {
    ...versionProperty,
    page: SessionPageSchema,
  },
  { additionalProperties: false },
)

export const SessionGetPayloadSchema = Type.Object(
  { ...versionProperty, sessionId: SessionIdSchema },
  { additionalProperties: false },
)
export const SessionGetResultSchema = Type.Object(
  { ...versionProperty, snapshot: SessionSnapshotSchema },
  { additionalProperties: false },
)

export const SessionCreatePayloadSchema = Type.Object(
  {
    ...versionProperty,
    projectId: ProjectIdSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    permissionMode: Type.Optional(PermissionModeSchema),
    modelSelection: Type.Optional(ModelSelectionSchema),
  },
  { additionalProperties: false },
)

export const SessionUpdatePatchSchema = Type.Union([
  Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 256 }),
      permissionMode: Type.Optional(PermissionModeSchema),
      modelSelection: Type.Optional(ModelSelectionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      permissionMode: PermissionModeSchema,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      modelSelection: Type.Optional(ModelSelectionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      modelSelection: ModelSelectionSchema,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      permissionMode: Type.Optional(PermissionModeSchema),
    },
    { additionalProperties: false },
  ),
])
export const SessionUpdatePayloadSchema = Type.Object(
  {
    ...versionProperty,
    sessionId: SessionIdSchema,
    expectedRevision: RevisionSchema,
    patch: SessionUpdatePatchSchema,
  },
  { additionalProperties: false },
)

export const SessionArchivePayloadSchema = Type.Object(
  {
    ...versionProperty,
    sessionId: SessionIdSchema,
    expectedRevision: RevisionSchema,
  },
  { additionalProperties: false },
)

export const MessageListPayloadSchema = Type.Object(
  {
    ...versionProperty,
    sessionId: SessionIdSchema,
    beforeSeq: Type.Optional(MessageSeqSchema),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_MESSAGE_PAGE_RECORDS }),
    ),
  },
  { additionalProperties: false },
)
export const MessageListResultSchema = Type.Object(
  { ...versionProperty, page: MessagePageSchema },
  { additionalProperties: false },
)

export const FileChangeListPayloadSchema = Type.Object(
  { ...versionProperty, sessionId: SessionIdSchema },
  { additionalProperties: false },
)
export const FileChangeListResultSchema = Type.Object(
  {
    ...versionProperty,
    sessionId: SessionIdSchema,
    fileChanges: Type.Array(FileChangeSummarySchema, {
      maxItems: MAX_FILE_CHANGE_RECORDS,
    }),
  },
  { additionalProperties: false },
)

export const FileChangeRevertPayloadSchema = Type.Object(
  {
    ...versionProperty,
    sessionId: SessionIdSchema,
    fileChangeId: FileChangeIdSchema,
    expectedRevision: RevisionSchema,
  },
  { additionalProperties: false },
)

export const DOMAIN_STATE_API_CONTRACTS = {
  'app:get-bootstrap': {
    payload: AppBootstrapPayloadSchema,
    result: AppBootstrapResultSchema,
  },
  'project:list': {
    payload: ProjectListPayloadSchema,
    result: ProjectListResultSchema,
  },
  'project:add': {
    payload: ProjectAddPayloadSchema,
    result: ProjectCommandResultSchema,
  },
  'project:update': {
    payload: ProjectUpdatePayloadSchema,
    result: ProjectCommandResultSchema,
  },
  'project:remove': {
    payload: ProjectRemovePayloadSchema,
    result: ProjectCommandResultSchema,
  },
  'session:list': {
    payload: SessionListPayloadSchema,
    result: SessionListResultSchema,
  },
  'session:get': {
    payload: SessionGetPayloadSchema,
    result: SessionGetResultSchema,
  },
  'session:create': {
    payload: SessionCreatePayloadSchema,
    result: SessionCommandResultSchema,
  },
  'session:update': {
    payload: SessionUpdatePayloadSchema,
    result: SessionCommandResultSchema,
  },
  'session:archive': {
    payload: SessionArchivePayloadSchema,
    result: SessionCommandResultSchema,
  },
  'message:list': {
    payload: MessageListPayloadSchema,
    result: MessageListResultSchema,
  },
  'file-change:list': {
    payload: FileChangeListPayloadSchema,
    result: FileChangeListResultSchema,
  },
  'file-change:revert': {
    payload: FileChangeRevertPayloadSchema,
    result: FileChangeCommandResultSchema,
  },
} as const

export type DomainStateApiChannel = keyof typeof DOMAIN_STATE_API_CONTRACTS
export type DomainStateApiPayload<Channel extends DomainStateApiChannel> =
  Static<(typeof DOMAIN_STATE_API_CONTRACTS)[Channel]['payload']>
export type DomainStateApiResult<Channel extends DomainStateApiChannel> =
  Static<(typeof DOMAIN_STATE_API_CONTRACTS)[Channel]['result']>
