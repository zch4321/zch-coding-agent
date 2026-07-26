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
import { dateTimeColumn } from './codec-helpers'

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
export const MAX_CROSS_SESSION_SEARCH_RESULTS = 100

/** Persists and queries session records. */
export class SessionRepository {
  /** Returns or updates insert state. */
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

  /** Updates the requested record. */
  update(
    transaction: PersistenceTransaction,
    record: SessionRecord,
    expectedRevision: number,
  ): boolean {
    const row = encodeSessionRow(record)
    assertRevisionTransition(expectedRevision, row.revision)
    const result = transaction
      .prepare(
        `UPDATE sessions
         SET project_id = ?, title = ?, lifecycle = ?, permission_mode = ?,
             provider_id = ?, model = ?, reasoning = ?, goal_json = ?,
             plan_json = ?, parent_session_id = ?, forked_from_seq = ?,
             revision = ?, last_seq = ?, updated_at = ?, archived_at = ?
         WHERE id = ? AND revision = ?
           AND ? >= COALESCE(
             (SELECT MAX(seq) FROM messages WHERE session_id = ?),
             0
           )`,
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
        expectedRevision,
        row.last_seq,
        row.id,
      )
    return Number(result.changes) > 0
  }

  /** Deletes the requested record. */
  delete(transaction: PersistenceTransaction, id: SessionId): boolean {
    const result = transaction
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(id)
    return Number(result.changes) > 0
  }

  /** Returns the requested record. */
  get(reader: PersistenceReader, id: SessionId): SessionRecord | undefined {
    const row = reader
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id)
    return row ? decodeSessionRow(row) : undefined
  }

  /** Lists page. */
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
      const updatedAt = dateTimeColumn(
        query.before.updatedAt,
        'session cursor updatedAt',
      )
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
      parameters.push(updatedAt, updatedAt, query.before.sessionId)
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

  /** Searches candidate ids. */
  searchCandidateIds(
    reader: PersistenceReader,
    input: { text: string; projectId?: ProjectId; limit?: number },
  ): SessionId[] {
    const text = input.text.trim()
    if (text.length < 1 || text.length > MAX_SESSION_SEARCH_LENGTH) {
      throw new PersistenceError(
        'CODEC_INVALID',
        `Session search text must contain between 1 and ${MAX_SESSION_SEARCH_LENGTH} characters`,
      )
    }
    const limit = boundedLimit(
      input.limit ?? MAX_CROSS_SESSION_SEARCH_RESULTS,
      MAX_CROSS_SESSION_SEARCH_RESULTS,
      'Cross-Session search result limit',
    )
    const projectClause = input.projectId ? 'AND s.project_id = ?' : ''
    const parameters: Array<string | number> = [text, text]
    if (input.projectId) parameters.push(input.projectId)
    parameters.push(limit)
    const rows = reader
      .prepare(
        `SELECT s.id
         FROM sessions s
         WHERE s.lifecycle = 'active'
           AND (
             instr(lower(s.title), lower(?)) > 0
             OR EXISTS (
               SELECT 1
               FROM messages m
               WHERE m.session_id = s.id
                 AND m.visibility = 'visible'
                 AND m.kind IN ('user_input', 'assistant_turn')
                 AND (
                   m.kind <> 'user_input'
                   OR m.replayed_from_message_id IS NULL
                 )
                 AND instr(lower(m.parts_json), lower(?)) > 0
             )
           )
           ${projectClause}
         ORDER BY s.updated_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...parameters)
    return rows.map(
      (row) => String((row as Record<string, unknown>).id) as SessionId,
    )
  }
}

function assertRevisionTransition(expected: number, next: number): void {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    next !== expected + 1
  ) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Session update revision must increment by exactly one',
    )
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (Number.isInteger(value) && value >= 1 && value <= maximum) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be between 1 and ${maximum}`,
  )
}
