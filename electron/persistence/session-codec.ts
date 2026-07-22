import type { ProjectId, SessionId } from '../../shared/ids'
import { SessionRecordSchema, type SessionRecord } from '../../shared/session'
import { compileSchema } from '../schema-validator'
import {
  assertSchemaValue,
  encodeJsonColumn,
  integerColumn,
  nullableStringColumn,
  parseNullableJsonColumn,
  stringColumn,
} from './codec-helpers'
import { PersistenceError } from './persistence-error'

const validateSessionRecord = compileSchema(SessionRecordSchema)

export interface SessionRow {
  schema_version: number
  id: string
  project_id: string
  title: string
  lifecycle: string
  permission_mode: string
  provider_id: string
  model: string
  reasoning: string
  goal_json: string | null
  plan_json: string | null
  parent_session_id: string | null
  forked_from_seq: number | null
  revision: number
  last_seq: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export function encodeSessionRow(record: SessionRecord): SessionRow {
  assertSchemaValue<SessionRecord>(
    validateSessionRecord,
    record,
    'SessionRecord',
  )
  return {
    schema_version: record.schemaVersion,
    id: record.id,
    project_id: record.projectId,
    title: record.title,
    lifecycle: record.lifecycle,
    permission_mode: record.permissionMode,
    provider_id: record.modelSelection.providerId,
    model: record.modelSelection.model,
    reasoning: record.modelSelection.reasoning,
    goal_json:
      record.goal === null ? null : encodeJsonColumn(record.goal, 'goal_json'),
    plan_json:
      record.plan === null ? null : encodeJsonColumn(record.plan, 'plan_json'),
    parent_session_id: record.parent?.sessionId ?? null,
    forked_from_seq: record.parent?.forkedFromSeq ?? null,
    revision: record.revision,
    last_seq: record.lastSeq,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    archived_at: record.lifecycle === 'archived' ? record.archivedAt : null,
  }
}

export function decodeSessionRow(row: Record<string, unknown>): SessionRecord {
  const parentSessionId = nullableStringColumn(
    row.parent_session_id,
    'sessions.parent_session_id',
  )
  const forkedFromSeq = nullableIntegerColumn(
    row.forked_from_seq,
    'sessions.forked_from_seq',
  )
  if ((parentSessionId === null) !== (forkedFromSeq === null)) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Session parent_session_id and forked_from_seq must both be null or present',
    )
  }

  const archivedAt = nullableStringColumn(
    row.archived_at,
    'sessions.archived_at',
  )
  const lifecycle = stringColumn(row.lifecycle, 'sessions.lifecycle')
  const record = {
    schemaVersion: integerColumn(row.schema_version, 'sessions.schema_version'),
    id: stringColumn(row.id, 'sessions.id') as SessionId,
    projectId: stringColumn(row.project_id, 'sessions.project_id') as ProjectId,
    title: stringColumn(row.title, 'sessions.title'),
    lifecycle,
    permissionMode: stringColumn(
      row.permission_mode,
      'sessions.permission_mode',
    ),
    modelSelection: {
      providerId: stringColumn(row.provider_id, 'sessions.provider_id'),
      model: stringColumn(row.model, 'sessions.model'),
      reasoning: stringColumn(row.reasoning, 'sessions.reasoning'),
    },
    goal: parseNullableJsonColumn(row.goal_json, 'sessions.goal_json'),
    plan: parseNullableJsonColumn(row.plan_json, 'sessions.plan_json'),
    ...(parentSessionId !== null && forkedFromSeq !== null
      ? {
          parent: {
            sessionId: parentSessionId as SessionId,
            forkedFromSeq,
          },
        }
      : {}),
    revision: integerColumn(row.revision, 'sessions.revision'),
    lastSeq: integerColumn(row.last_seq, 'sessions.last_seq'),
    createdAt: stringColumn(row.created_at, 'sessions.created_at'),
    updatedAt: stringColumn(row.updated_at, 'sessions.updated_at'),
    ...(archivedAt === null ? {} : { archivedAt }),
  }
  assertSchemaValue<SessionRecord>(
    validateSessionRecord,
    record,
    'SessionRecord row',
  )
  return record
}

function nullableIntegerColumn(value: unknown, column: string): number | null {
  return value === null ? null : integerColumn(value, column)
}
