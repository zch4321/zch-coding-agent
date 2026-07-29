import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'

export type SubagentExecutionStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'

export interface SubagentExecutionRecord {
  id: string
  parentSessionId: SessionId
  parentRunId: RunId
  parentCallId: CallId
  specHash: string
  status: SubagentExecutionStatus
  route: JsonValue
  sourceIdentity?: JsonValue
  usage?: JsonValue
  result?: JsonValue
  error?: { code: string; message: string }
  createdAt: string
  updatedAt: string
  completedAt?: string
}

interface SubagentExecutionRow {
  id: string
  parent_session_id: string
  parent_run_id: string
  parent_call_id: string
  spec_hash: string
  status: SubagentExecutionStatus
  route_json: string
  source_identity_json: string | null
  usage_json: string | null
  result_json: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const EXECUTION_COLUMNS = `
  id, parent_session_id, parent_run_id, parent_call_id, spec_hash,
  status, route_json, source_identity_json, usage_json,
  result_json, error_code, error_message, created_at, updated_at, completed_at
`

/** Persists hidden Subagent execution identity, lifecycle, results, and Session ownership. */
export class SubagentRepository {
  /** Inserts a preparing execution before snapshot or Provider work begins. */
  insert(
    transaction: PersistenceTransaction,
    record: SubagentExecutionRecord,
  ): void {
    transaction
      .prepare(
        `INSERT INTO subagent_executions (schema_version, ${EXECUTION_COLUMNS})
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.parentSessionId,
        record.parentRunId,
        record.parentCallId,
        record.specHash,
        record.status,
        JSON.stringify(record.route),
        record.sourceIdentity === undefined
          ? null
          : JSON.stringify(record.sourceIdentity),
        record.usage === undefined ? null : JSON.stringify(record.usage),
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error?.code ?? null,
        record.error?.message ?? null,
        record.createdAt,
        record.updatedAt,
        record.completedAt ?? null,
      )
  }

  /** Finds an execution by its stable parent Tool-call identity. */
  findByParentCall(
    reader: PersistenceReader,
    input: {
      parentSessionId: SessionId
      parentRunId: RunId
      parentCallId: CallId
    },
  ): SubagentExecutionRecord | undefined {
    const row = reader
      .prepare(
        `SELECT ${EXECUTION_COLUMNS}
         FROM subagent_executions
         WHERE parent_session_id = ? AND parent_run_id = ? AND parent_call_id = ?`,
      )
      .get(input.parentSessionId, input.parentRunId, input.parentCallId) as
      | SubagentExecutionRow
      | undefined
    return row ? decodeExecution(row) : undefined
  }

  /** Associates a newly committed hidden Session with its execution and parent. */
  attachSession(
    transaction: PersistenceTransaction,
    input: {
      sessionId: SessionId
      executionId: string
      parentSessionId: SessionId
      createdAt: string
    },
  ): void {
    transaction
      .prepare(
        `INSERT INTO subagent_sessions (
           schema_version, session_id, execution_id, parent_session_id, created_at
         ) VALUES (1, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.executionId,
        input.parentSessionId,
        input.createdAt,
      )
  }

  /** Updates one execution with its current lifecycle and bounded diagnostics. */
  update(
    transaction: PersistenceTransaction,
    record: SubagentExecutionRecord,
  ): boolean {
    const result = transaction
      .prepare(
        `UPDATE subagent_executions
         SET status = ?, source_identity_json = ?, usage_json = ?,
             result_json = ?, error_code = ?, error_message = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        record.status,
        record.sourceIdentity === undefined
          ? null
          : JSON.stringify(record.sourceIdentity),
        record.usage === undefined ? null : JSON.stringify(record.usage),
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error?.code ?? null,
        record.error?.message ?? null,
        record.updatedAt,
        record.completedAt ?? null,
        record.id,
      )
    return Number(result.changes) === 1
  }

  /** Marks executions left active by a previous process as interrupted. */
  interruptActive(
    transaction: PersistenceTransaction,
    timestamp: string,
  ): number {
    const result = transaction
      .prepare(
        `UPDATE subagent_executions
         SET status = 'interrupted', updated_at = ?, completed_at = ?,
             error_code = 'SUBAGENT_INTERRUPTED',
             error_message = 'The application stopped before the Subagent completed'
         WHERE status IN ('preparing', 'running')`,
      )
      .run(timestamp, timestamp)
    return Number(result.changes)
  }

  /** Reports whether a Session is hidden as a Subagent child. */
  isInternalSession(reader: PersistenceReader, sessionId: SessionId): boolean {
    return Boolean(
      reader
        .prepare(`SELECT 1 FROM subagent_sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId),
    )
  }
}

function decodeExecution(row: SubagentExecutionRow): SubagentExecutionRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id as SessionId,
    parentRunId: row.parent_run_id as RunId,
    parentCallId: row.parent_call_id as CallId,
    specHash: row.spec_hash,
    status: row.status,
    route: JSON.parse(row.route_json) as JsonValue,
    ...(row.source_identity_json
      ? { sourceIdentity: JSON.parse(row.source_identity_json) as JsonValue }
      : {}),
    ...(row.usage_json
      ? { usage: JSON.parse(row.usage_json) as JsonValue }
      : {}),
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as JsonValue }
      : {}),
    ...(row.error_code && row.error_message
      ? { error: { code: row.error_code, message: row.error_message } }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  }
}
