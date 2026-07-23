import { Type, type Static } from '@sinclair/typebox'
import { PermissionModeSchema } from './config'
import {
  DateTimeSchema,
  DurableSchemaVersionSchema,
  LastMessageSeqSchema,
  MAX_SESSION_LIST_RECORDS,
  RevisionSchema,
} from './durable'
import { ProjectIdSchema, SessionIdSchema } from './ids'
import {
  assertMessagePageSemantics,
  MessagePageSchema,
  type MessagePage,
} from './message'
import { ModelSelectionSchema } from './model-route'
import { GoalStateSchema, PlanStateSchema } from './orchestration'
import { ActiveRunPublicSnapshotSchema } from './runtime-state'

export const SessionLifecycleSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('archived'),
])
export type SessionLifecycle = Static<typeof SessionLifecycleSchema>

const SessionParentSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    forkedFromSeq: LastMessageSeqSchema,
  },
  { additionalProperties: false },
)

const sessionRecordProperties = {
  schemaVersion: DurableSchemaVersionSchema,
  id: SessionIdSchema,
  projectId: ProjectIdSchema,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  permissionMode: PermissionModeSchema,
  modelSelection: ModelSelectionSchema,
  goal: Type.Union([GoalStateSchema, Type.Null()]),
  plan: Type.Union([PlanStateSchema, Type.Null()]),
  parent: Type.Optional(SessionParentSchema),
  revision: RevisionSchema,
  lastSeq: LastMessageSeqSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
}

export const SessionRecordSchema = Type.Union([
  Type.Object(
    {
      ...sessionRecordProperties,
      lifecycle: Type.Literal('active'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...sessionRecordProperties,
      lifecycle: Type.Literal('archived'),
      archivedAt: DateTimeSchema,
    },
    { additionalProperties: false },
  ),
])
export type SessionRecord = Static<typeof SessionRecordSchema>

// Session records contain only bounded metadata and are the list-page summary.
// Message bodies are always queried separately through MessagePage.
export const SessionSummarySchema = SessionRecordSchema
export type SessionSummary = SessionRecord

export const SessionListCursorSchema = Type.Object(
  {
    updatedAt: DateTimeSchema,
    sessionId: SessionIdSchema,
  },
  { additionalProperties: false },
)
export type SessionListCursor = Static<typeof SessionListCursorSchema>

const sessionPageProperties = {
  schemaVersion: DurableSchemaVersionSchema,
}

export const SessionPageSchema = Type.Union([
  Type.Object(
    {
      ...sessionPageProperties,
      records: Type.Array(SessionSummarySchema, {
        minItems: 1,
        maxItems: MAX_SESSION_LIST_RECORDS,
      }),
      hasMore: Type.Literal(true),
      nextBefore: SessionListCursorSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...sessionPageProperties,
      records: Type.Array(SessionSummarySchema, {
        maxItems: MAX_SESSION_LIST_RECORDS,
      }),
      hasMore: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
])
export type SessionPage = Static<typeof SessionPageSchema>

export const SessionSnapshotSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    session: SessionRecordSchema,
    messagePage: MessagePageSchema,
    runtime: Type.Optional(ActiveRunPublicSnapshotSchema),
  },
  { additionalProperties: false },
)
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>

export function assertSessionSnapshotSemantics(
  snapshot: SessionSnapshot,
): void {
  const page = snapshot.messagePage as MessagePage
  if (page.sessionId !== snapshot.session.id) {
    throw new TypeError(
      'Session snapshot message page belongs to another Session',
    )
  }
  assertMessagePageSemantics(page)

  const lastRecord = page.records.at(-1)
  if (lastRecord && lastRecord.seq > snapshot.session.lastSeq) {
    throw new TypeError(
      'Session snapshot contains a seq beyond Session.lastSeq',
    )
  }
  if (snapshot.session.lastSeq === 0 && page.records.length > 0) {
    throw new TypeError('Empty Session cannot contain Message records')
  }
  if (snapshot.runtime?.sessionId !== undefined) {
    if (snapshot.runtime.sessionId !== snapshot.session.id) {
      throw new TypeError('Session snapshot runtime belongs to another Session')
    }
  }
}

export function assertSessionPageSemantics(page: SessionPage): void {
  for (const record of page.records) {
    if (!Number.isFinite(Date.parse(record.updatedAt))) {
      throw new TypeError('Session page contains an invalid updatedAt value')
    }
  }
  for (let index = 1; index < page.records.length; index += 1) {
    const previous = page.records[index - 1]!
    const current = page.records[index]!
    const previousUpdatedAt = Date.parse(previous.updatedAt)
    const currentUpdatedAt = Date.parse(current.updatedAt)
    if (
      currentUpdatedAt > previousUpdatedAt ||
      (currentUpdatedAt === previousUpdatedAt && current.id >= previous.id)
    ) {
      throw new TypeError(
        'Session page records must use updatedAt/id descending order',
      )
    }
  }

  if (!page.hasMore) return
  const last = page.records.at(-1)!
  if (
    page.nextBefore.updatedAt !== last.updatedAt ||
    page.nextBefore.sessionId !== last.id
  ) {
    throw new TypeError(
      'Session page nextBefore must identify the last returned Session',
    )
  }
}
