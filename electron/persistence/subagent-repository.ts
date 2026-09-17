import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type {
  AgentExecutionCounts,
  AgentExecutionKind,
  AgentExecutionListCursor,
  AgentExecutionStatus,
} from '../../shared/agent-execution'
import type { JsonValue } from '../../shared/json'
import {
  parseExecutionUsage,
  type AgentExecutionUsageSummary,
} from '../../shared/execution-usage'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'

export interface SubagentExecutionRecord {
  id: AgentExecutionId
  kind: AgentExecutionKind
  childSessionId?: SessionId
  childRunId?: RunId
  parentExecutionId?: AgentExecutionId
  childOrdinal?: number
  name: string
  parentSessionId: SessionId
  parentRunId: RunId
  parentCallId: CallId
  specHash: string
  status: AgentExecutionStatus
  route: JsonValue
  sourceIdentity?: JsonValue
  usage?: AgentExecutionUsageSummary
  result?: JsonValue
  error?: { code: string; message: string }
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type SubagentExecutionState = Pick<
  SubagentExecutionRecord,
  'id' | 'kind' | 'status'
> & { currentExecutionId?: AgentExecutionId; childSessionId?: SessionId }

interface SubagentExecutionRow {
  id: string
  kind: AgentExecutionKind
  child_session_id: string | null
  child_run_id: string | null
  parent_execution_id: string | null
  child_ordinal: number | null
  name: string
  parent_session_id: string
  parent_run_id: string
  parent_call_id: string
  spec_hash: string
  status: AgentExecutionStatus
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

export interface SubagentExecutionListEntry {
  record: SubagentExecutionRecord
  childSessionId?: SessionId
}

export interface SubagentExecutionListPage {
  records: SubagentExecutionListEntry[]
  hasMore: boolean
  nextBefore?: AgentExecutionListCursor
}

const EXECUTION_COLUMNS = `
  id, kind, child_session_id, child_run_id, parent_execution_id, child_ordinal, name,
  parent_session_id, parent_run_id, parent_call_id, spec_hash,
  status, route_json, source_identity_json, usage_json,
  result_json, error_code, error_message, created_at, updated_at, completed_at
`

const ALIASED_EXECUTION_COLUMNS = `
  e.id, e.kind, e.child_session_id, e.child_run_id, e.parent_execution_id, e.child_ordinal, e.name,
  e.parent_session_id, e.parent_run_id, e.parent_call_id, e.spec_hash,
  e.status, e.route_json, e.source_identity_json, e.usage_json,
  e.result_json, e.error_code, e.error_message, e.created_at, e.updated_at,
  e.completed_at
`

const LATEST_STATUS =
  'COALESCE((SELECT recent.status FROM subagent_executions recent WHERE recent.child_session_id = e.child_session_id ORDER BY recent.created_at DESC,recent.rowid DESC LIMIT 1),e.status)'
const ACTIVE_CHILDREN =
  "EXISTS(SELECT 1 FROM subagent_executions member JOIN subagent_executions recent ON recent.id = COALESCE((SELECT r.id FROM subagent_executions r WHERE r.child_session_id = member.child_session_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1),member.id) WHERE member.parent_execution_id = e.id AND recent.status IN ('queued','preparing','running'))"
const ACTIVE_ROOT = `(${LATEST_STATUS} IN ('queued','preparing','running') OR (e.kind = 'swarm' AND ${ACTIVE_CHILDREN}))`

/** Persists hidden Subagent execution identity, lifecycle, results, and Session ownership. */
export class SubagentRepository {
  /** Builds a stable sidebar identity with the latest execution data; never used for execution writes. */
  presentationRecord(
    reader: PersistenceReader,
    record: SubagentExecutionRecord,
  ): SubagentExecutionRecord {
    if (!record.childSessionId) return record
    const row = reader
      .prepare(
        "SELECT json_extract(agent_metadata_json, '$.initialExecutionId') AS id FROM sessions WHERE id = ? AND owner_session_id = ?",
      )
      .get(record.childSessionId, record.parentSessionId) as
      | { id: AgentExecutionId }
      | undefined
    const original = row
      ? this.getOwned(reader, {
          parentSessionId: record.parentSessionId,
          executionId: row.id,
        })?.record
      : undefined
    const latest =
      this.latestForSession(
        reader,
        record.parentSessionId,
        record.childSessionId,
      ) ?? record
    if (!original) return latest
    return {
      ...latest,
      id: original.id,
      createdAt: original.createdAt,
      parentExecutionId: original.parentExecutionId,
      childOrdinal: original.childOrdinal,
    }
  }

  /** Reads only parent-owned lifecycle fields, avoiding result/route JSON decoding while polling. */
  getOwnedStates(
    reader: PersistenceReader,
    parentSessionId: SessionId,
    executionIds: readonly AgentExecutionId[],
  ): SubagentExecutionState[] {
    const ids = [...new Set(executionIds)]
    if (ids.length === 0) return []
    const rows = reader
      .prepare(
        `SELECT e.id, e.kind, latest.status, latest.id AS current_execution_id, e.child_session_id
      FROM subagent_executions e JOIN subagent_executions latest ON latest.id = COALESCE((SELECT id FROM subagent_executions recent WHERE recent.child_session_id = e.child_session_id ORDER BY recent.created_at DESC, recent.rowid DESC LIMIT 1), e.id)
      WHERE e.parent_session_id = ? AND e.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(parentSessionId, ...ids) as unknown as Array<
      Pick<
        SubagentExecutionRow,
        'id' | 'kind' | 'status' | 'child_session_id'
      > & { current_execution_id: string }
    >
    return rows.map((row) => ({
      id: row.id as AgentExecutionId,
      kind: row.kind,
      status: row.status,
      ...(row.current_execution_id !== row.id
        ? { currentExecutionId: row.current_execution_id as AgentExecutionId }
        : {}),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as SessionId }
        : {}),
    }))
  }

  /** Counts active top-level tasks independently of the loaded sidebar page. */
  countActiveRoots(
    reader: PersistenceReader,
    parentSessionId: SessionId,
  ): number {
    return Number(
      (
        reader
          .prepare(
            `SELECT COUNT(*) AS count FROM subagent_executions e LEFT JOIN sessions child ON child.id = e.child_session_id
      WHERE e.parent_session_id = ? AND e.parent_execution_id IS NULL AND (child.id IS NULL OR json_extract(child.agent_metadata_json,'$.initialExecutionId') = e.id) AND ${ACTIVE_ROOT}`,
          )
          .get(parentSessionId) as { count: number }
      ).count,
    )
  }

  /** Reports current member activity without rewriting the original Swarm result/counts. */
  hasActiveChildren(reader: PersistenceReader, id: AgentExecutionId): boolean {
    return !!reader
      .prepare(
        `SELECT 1 FROM subagent_executions e WHERE e.id = ? AND e.kind = 'swarm' AND ${ACTIVE_CHILDREN}`,
      )
      .get(id)
  }

  /** Lists root records in the sidebar's active-first mixed-task order. */
  listBackgroundRoots(
    reader: PersistenceReader,
    input: {
      parentSessionId: SessionId
      before?: { active: boolean; createdAt: string; key: string }
      limit: number
    },
  ): SubagentExecutionListEntry[] {
    const active = ACTIVE_ROOT
    const values: (string | number)[] = [input.parentSessionId]
    let where = ''
    if (input.before) {
      where = `AND (${active} < ? OR (${active} = ? AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))))`
      values.push(
        Number(input.before.active),
        Number(input.before.active),
        input.before.createdAt,
        input.before.createdAt,
        input.before.key,
      )
    }
    const rows = reader
      .prepare(
        `SELECT ${ALIASED_EXECUTION_COLUMNS}, child.id AS child_session_id
      FROM subagent_executions e LEFT JOIN sessions child ON child.id = e.child_session_id
      WHERE e.parent_session_id = ? AND e.parent_execution_id IS NULL AND (child.id IS NULL OR json_extract(child.agent_metadata_json, '$.initialExecutionId') = e.id) ${where}
      ORDER BY ${active} DESC, e.created_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...values, input.limit) as unknown as Array<
      SubagentExecutionRow & { child_session_id: string | null }
    >
    return rows.map((row) => ({
      record: decodeExecution(row),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as SessionId }
        : {}),
    }))
  }

  /** Counts active leaf executions for one public parent Session. */
  countActiveLeaves(
    reader: PersistenceReader,
    parentSessionId: SessionId,
  ): number {
    const row = reader
      .prepare(
        `SELECT COUNT(*) AS count
         FROM subagent_executions
         WHERE parent_session_id = ? AND kind = 'subagent'
           AND status IN ('queued', 'preparing', 'running')`,
      )
      .get(parentSessionId) as { count: number }
    return Number(row.count)
  }

  /** Inserts a preparing execution before snapshot or Provider work begins. */
  insert(
    transaction: PersistenceTransaction,
    record: SubagentExecutionRecord,
  ): void {
    transaction
      .prepare(
        `INSERT INTO subagent_executions (schema_version, ${EXECUTION_COLUMNS})
         VALUES (2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.childSessionId ?? null,
        record.childRunId ?? null,
        record.parentExecutionId ?? null,
        record.childOrdinal ?? null,
        record.name,
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
         WHERE parent_session_id = ? AND parent_run_id = ? AND parent_call_id = ?
           AND parent_execution_id IS NULL`,
      )
      .get(input.parentSessionId, input.parentRunId, input.parentCallId) as
      | SubagentExecutionRow
      | undefined
    return row ? decodeExecution(row) : undefined
  }

  /** Lists a bounded execution page owned by one public parent Session. */
  listByParentSession(
    reader: PersistenceReader,
    input: {
      parentSessionId: SessionId
      before?: AgentExecutionListCursor
      limit: number
    },
  ): SubagentExecutionListPage {
    const parameters: Array<string | number> = [input.parentSessionId]
    const cursor = input.before
      ? 'AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))'
      : ''
    if (input.before) {
      parameters.push(
        input.before.createdAt,
        input.before.createdAt,
        input.before.executionId,
      )
    }
    const rows = reader
      .prepare(
        `SELECT ${ALIASED_EXECUTION_COLUMNS},
                child.id AS child_session_id
         FROM subagent_executions e
         LEFT JOIN sessions child ON child.id = e.child_session_id
         WHERE e.parent_session_id = ? AND e.parent_execution_id IS NULL AND (child.id IS NULL OR json_extract(child.agent_metadata_json, '$.initialExecutionId') = e.id) ${cursor}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
      )
      .all(...parameters, input.limit + 1) as unknown as Array<
      SubagentExecutionRow & { child_session_id: string | null }
    >
    const hasMore = rows.length > input.limit
    const records = rows.slice(0, input.limit).map((row) => ({
      record: decodeExecution(row),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as SessionId }
        : {}),
    }))
    const last = records.at(-1)?.record
    return {
      records,
      hasMore,
      ...(hasMore && last
        ? {
            nextBefore: {
              createdAt: last.createdAt,
              executionId: last.id,
            },
          }
        : {}),
    }
  }

  /** Lists every child execution for one owned Swarm root in declaration order. */
  listChildren(
    reader: PersistenceReader,
    input: {
      parentSessionId: SessionId
      parentExecutionId: AgentExecutionId
    },
  ): SubagentExecutionListEntry[] {
    const rows = reader
      .prepare(
        `SELECT ${ALIASED_EXECUTION_COLUMNS},
                child.id AS child_session_id
         FROM subagent_executions e
         LEFT JOIN sessions child ON child.id = e.child_session_id
         WHERE e.parent_session_id = ? AND e.parent_execution_id = ?
         ORDER BY e.child_ordinal ASC, e.id ASC`,
      )
      .all(input.parentSessionId, input.parentExecutionId) as unknown as Array<
      SubagentExecutionRow & { child_session_id: string | null }
    >
    return rows.map((row) => ({
      record: decodeExecution(row),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as SessionId }
        : {}),
    }))
  }

  /** Aggregates child lifecycle counts for one Swarm root. */
  childCounts(
    reader: PersistenceReader,
    parentExecutionId: AgentExecutionId,
  ): AgentExecutionCounts {
    const rows = reader
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM subagent_executions
         WHERE parent_execution_id = ?
         GROUP BY status`,
      )
      .all(parentExecutionId) as unknown as Array<{
      status: AgentExecutionStatus
      count: number
    }>
    const counts: AgentExecutionCounts = {
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
    }
    for (const row of rows) {
      counts.total += row.count
      if (row.status === 'queued' || row.status === 'preparing') {
        counts.queued += row.count
      } else if (row.status === 'running') {
        counts.running += row.count
      } else if (row.status === 'completed') {
        counts.completed += row.count
      } else {
        counts.failed += row.count
      }
    }
    return counts
  }

  /** Loads one execution only when it belongs to the supplied public parent Session. */
  getOwned(
    reader: PersistenceReader,
    input: { parentSessionId: SessionId; executionId: AgentExecutionId },
  ): SubagentExecutionListEntry | undefined {
    const row = reader
      .prepare(
        `SELECT ${ALIASED_EXECUTION_COLUMNS},
                child.id AS child_session_id
         FROM subagent_executions e
         LEFT JOIN sessions child ON child.id = e.child_session_id
         WHERE e.parent_session_id = ? AND e.id = ?`,
      )
      .get(input.parentSessionId, input.executionId) as
      | (SubagentExecutionRow & { child_session_id: string | null })
      | undefined
    if (!row) return undefined
    return {
      record: decodeExecution(row),
      ...(row.child_session_id
        ? { childSessionId: row.child_session_id as SessionId }
        : {}),
    }
  }

  /** Returns the current execution for an owned persistent child Session. */
  latestForSession(
    reader: PersistenceReader,
    parentSessionId: SessionId,
    sessionId: SessionId,
  ): SubagentExecutionRecord | undefined {
    const row = reader
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM subagent_executions
      WHERE parent_session_id = ? AND child_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(parentSessionId, sessionId) as SubagentExecutionRow | undefined
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
    const owner = transaction
      .prepare(
        'SELECT project_id FROM sessions WHERE id = ? AND owner_session_id IS NULL',
      )
      .get(input.parentSessionId)
    const child = transaction
      .prepare('SELECT project_id, owner_session_id FROM sessions WHERE id = ?')
      .get(input.sessionId)
    if (
      !owner ||
      !child ||
      owner.project_id !== child.project_id ||
      (child.owner_session_id !== null &&
        child.owner_session_id !== input.parentSessionId)
    ) {
      throw new Error('Invalid delegated Session ownership')
    }
    const linked = transaction
      .prepare(
        `UPDATE subagent_executions SET child_session_id = ? WHERE id = ? AND parent_session_id = ? AND kind = 'subagent' AND (child_session_id IS NULL OR child_session_id = ?)`,
      )
      .run(
        input.sessionId,
        input.executionId,
        input.parentSessionId,
        input.sessionId,
      )
    if (linked.changes !== 1)
      throw new Error('Subagent execution was not found for its owner')
    transaction
      .prepare(
        'UPDATE sessions SET owner_session_id = ?, agent_metadata_json = COALESCE(agent_metadata_json, ?) WHERE id = ?',
      )
      .run(
        input.parentSessionId,
        JSON.stringify({ initialExecutionId: input.executionId }),
        input.sessionId,
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
         SET child_session_id = COALESCE(?, child_session_id), child_run_id = COALESCE(?, child_run_id), status = ?, source_identity_json = ?, usage_json = ?,
             result_json = ?, error_code = ?, error_message = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        record.childSessionId ?? null,
        record.childRunId ?? null,
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
             error_code = CASE
               WHEN kind = 'swarm' THEN 'SWARM_INTERRUPTED'
               ELSE 'SUBAGENT_INTERRUPTED'
             END,
             error_message = CASE
               WHEN kind = 'swarm'
                 THEN 'The application stopped before the Swarm completed'
               ELSE 'The application stopped before the Subagent completed'
             END
         WHERE status IN ('queued', 'preparing', 'running')`,
      )
      .run(timestamp, timestamp)
    return Number(result.changes)
  }

  /** Reports whether a Session is hidden as a Subagent child. */
  isInternalSession(reader: PersistenceReader, sessionId: SessionId): boolean {
    return Boolean(
      reader
        .prepare(
          `SELECT 1 FROM sessions WHERE id = ? AND owner_session_id IS NOT NULL LIMIT 1`,
        )
        .get(sessionId),
    )
  }
}

function decodeExecution(row: SubagentExecutionRow): SubagentExecutionRecord {
  return {
    id: row.id as AgentExecutionId,
    kind: row.kind,
    ...(row.child_session_id
      ? { childSessionId: row.child_session_id as SessionId }
      : {}),
    ...(row.child_run_id ? { childRunId: row.child_run_id as RunId } : {}),
    ...(row.parent_execution_id
      ? { parentExecutionId: row.parent_execution_id as AgentExecutionId }
      : {}),
    ...(row.child_ordinal !== null ? { childOrdinal: row.child_ordinal } : {}),
    name: row.name,
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
      ? { usage: parseExecutionUsage(JSON.parse(row.usage_json)) }
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
