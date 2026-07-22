import { MAX_SESSION_LIST_RECORDS } from '../../shared/durable'
import type { ProjectId, SessionId } from '../../shared/ids'
import {
  assertSessionPageSemantics,
  type SessionLifecycle,
  type SessionListCursor,
  type SessionPage,
  type SessionRecord,
} from '../../shared/session'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import { PersistenceError } from './persistence-error'
import { decodeSessionRow, encodeSessionRow } from './session-codec'

const SESSION_COLUMNS = `
  schema_version, id, project_id, title, lifecycle, permission_mode,
  provider_id, model, reasoning, goal_json, plan_json, parent_session_id,
  forked_from_seq, revision, last_seq, created_at, updated_at, archived_at
`

export interface SessionListQuery {
  projectId?: ProjectId
  lifecycle?: SessionLifecycle
  search?: string
  before?: SessionListCursor
  limit?: number
}

export const MAX_SESSION_SEARCH_LENGTH = 256

export class SessionRepository {
  insert(transaction: PersistenceTransaction, record: SessionRecord): void {
    const row = encodeSessionRow(record)
    transaction
      .prepare(
        `INSERT INTO sessions (
           schema_version, id, project_id, title, lifecycle, permission_mode,
           provider_id, model, reasoning, goal_json, plan_json,
           parent_session_id, forked_from_seq, revision, last_seq, created_at,
           updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.schema_version,
        row.id,
        row.project_id,
        row.title,
        row.lifecycle,
        row.permission_mode,
        row.provider_id,
        row.model,
        row.reasoning,
        row.goal_json,
        row.plan_json,
        row.parent_session_id,
        row.forked_from_seq,
        row.revision,
        row.last_seq,
        row.created_at,
        row.updated_at,
        row.archived_at,
      )
  }

  update(transaction: PersistenceTransaction, record: SessionRecord): boolean {
    const row = encodeSessionRow(record)
    const result = transaction
      .prepare(
        `UPDATE sessions
         SET project_id = ?, title = ?, lifecycle = ?, permission_mode = ?,
             provider_id = ?, model = ?, reasoning = ?, goal_json = ?,
             plan_json = ?, parent_session_id = ?, forked_from_seq = ?,
             revision = ?, last_seq = ?, updated_at = ?, archived_at = ?
         WHERE id = ?`,
      )
      .run(
        row.project_id,
        row.title,
        row.lifecycle,
        row.permission_mode,
        row.provider_id,
        row.model,
        row.reasoning,
        row.goal_json,
        row.plan_json,
        row.parent_session_id,
        row.forked_from_seq,
        row.revision,
        row.last_seq,
        row.updated_at,
        row.archived_at,
        row.id,
      )
    return Number(result.changes) > 0
  }

  delete(transaction: PersistenceTransaction, id: SessionId): boolean {
    const result = transaction
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(id)
    return Number(result.changes) > 0
  }

  get(reader: PersistenceReader, id: SessionId): SessionRecord | undefined {
    const row = reader
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id)
    return row ? decodeSessionRow(row) : undefined
  }

  listPage(
    reader: PersistenceReader,
    query: SessionListQuery = {},
  ): SessionPage {
    const limit = boundedLimit(
      query.limit ?? MAX_SESSION_LIST_RECORDS,
      MAX_SESSION_LIST_RECORDS,
      'Session page limit',
    )
    const clauses: string[] = []
    const parameters: Array<string | number> = []

    if (query.projectId) {
      clauses.push('project_id = ?')
      parameters.push(query.projectId)
    }
    if (query.lifecycle) {
      clauses.push('lifecycle = ?')
      parameters.push(query.lifecycle)
    }
    if (query.search !== undefined) {
      const search = query.search.trim()
      if (search.length < 1 || search.length > MAX_SESSION_SEARCH_LENGTH) {
        throw new PersistenceError(
          'CODEC_INVALID',
          `Session search text must contain between 1 and ${MAX_SESSION_SEARCH_LENGTH} characters`,
        )
      }
      clauses.push('instr(lower(title), lower(?)) > 0')
      parameters.push(search)
    }
    if (query.before) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
      parameters.push(
        query.before.updatedAt,
        query.before.updatedAt,
        query.before.sessionId,
      )
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = reader
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions
         ${where}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit + 1)
    const hasMore = rows.length > limit
    const records = rows.slice(0, limit).map(decodeSessionRow)
    const page: SessionPage = hasMore
      ? {
          schemaVersion: 1,
          records,
          hasMore: true,
          nextBefore: {
            updatedAt: records.at(-1)!.updatedAt,
            sessionId: records.at(-1)!.id,
          },
        }
      : { schemaVersion: 1, records, hasMore: false }
    assertSessionPageSemantics(page)
    return page
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (Number.isInteger(value) && value >= 1 && value <= maximum) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be between 1 and ${maximum}`,
  )
}
