import type { UsageCallInput } from '../usage/contracts'
import type { RunId, SessionId } from '../../shared/ids'
import {
  USAGE_METRICS,
  addUsageTotals,
  type SessionContextSnapshot,
  type SessionUsageSnapshot,
  type UsageSummary,
  type UsageTotals,
} from '../../shared/session-usage'
import type { LlmUsageRecord } from '../../shared/usage'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'

const columns = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_hit_tokens',
  'cache_miss_tokens',
] as const
const sums = columns.map((column) => `SUM(${column}) AS ${column}`).join(', ')
type Row = Record<string, unknown>

export interface StoredContext {
  runId: RunId
  revision: number
  snapshot: SessionContextSnapshot | null
  recipe: string | null
}

/** Stores source-call facts and queries public-session aggregates without replaying history. */
export class SessionUsageRepository {
  /** Inserts reported usage once, resolving hidden execution ownership inside the transaction. */
  insert(
    transaction: PersistenceTransaction,
    input: UsageCallInput,
  ): SessionId | undefined {
    if (input.usage.scope === 'subagent') return undefined
    const owner = transaction
      .prepare(
        `
      SELECT s.id, e.parent_session_id, e.parent_run_id, e.id AS execution_id, e.name
      FROM sessions s
      LEFT JOIN subagent_sessions child ON child.session_id = s.id
      LEFT JOIN subagent_executions e ON e.id = child.execution_id
      JOIN sessions owner ON owner.id = COALESCE(e.parent_session_id, s.id)
      WHERE s.id = ?
        AND owner.project_id = s.project_id
        AND NOT EXISTS (SELECT 1 FROM subagent_sessions hidden WHERE hidden.session_id = owner.id)
        AND (child.session_id IS NULL OR (e.kind = 'subagent' AND e.parent_session_id = child.parent_session_id))
    `,
      )
      .get(input.sessionId)
    if (!owner) return undefined
    const sessionId = (owner.parent_session_id ?? owner.id) as SessionId
    const usage = input.usage
    const values = USAGE_METRICS.map((metric) => usage[metric] ?? null)
    if (values.every((value) => value === null)) return undefined
    const inserted = transaction
      .prepare(
        `
      INSERT INTO session_usage_calls (
        session_id, source_session_id, call_id, run_id, scope, purpose,
        execution_id, task_name, provider_id, provider_label, model,
        ${columns.join(', ')}, context_window_tokens, context_window_source, created_at
      ) VALUES (${Array.from({ length: 20 }, () => '?').join(', ')})
      ON CONFLICT(source_session_id, call_id) DO NOTHING
    `,
      )
      .run(
        sessionId,
        input.sessionId,
        input.callId,
        owner.parent_run_id ?? input.runId,
        owner.execution_id ? 'subagent' : usage.scope,
        usage.scope,
        owner.execution_id ?? null,
        owner.name ?? null,
        usage.providerId,
        usage.providerLabel,
        usage.model,
        ...values,
        usage.contextWindowTokens,
        usage.contextWindowSource,
        new Date().toISOString(),
      )
    return inserted.changes ? sessionId : undefined
  }

  /** Reads a context snapshot and the credential-free recipe needed after a restart. */
  context(
    reader: PersistenceReader,
    sessionId: SessionId,
  ): StoredContext | undefined {
    const row = reader
      .prepare('SELECT * FROM session_context_snapshots WHERE session_id = ?')
      .get(sessionId)
    return row
      ? {
          runId: row.run_id as RunId,
          revision: Number(row.history_revision),
          snapshot:
            row.snapshot_json === null
              ? null
              : (JSON.parse(
                  String(row.snapshot_json),
                ) as SessionContextSnapshot),
          recipe: row.recipe_json === null ? null : String(row.recipe_json),
        }
      : undefined
  }

  /** Replaces the one current context snapshot owned by a Session. */
  saveContext(
    transaction: PersistenceTransaction,
    sessionId: SessionId,
    value: StoredContext,
  ): void {
    transaction
      .prepare(
        `INSERT INTO session_context_snapshots (session_id, run_id, history_revision, snapshot_json, recipe_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      run_id = excluded.run_id, history_revision = excluded.history_revision, snapshot_json = excluded.snapshot_json, recipe_json = excluded.recipe_json
    `,
      )
      .run(
        sessionId,
        value.runId,
        value.revision,
        value.snapshot ? JSON.stringify(value.snapshot) : null,
        value.recipe,
      )
  }

  /** Returns exact totals with bounded model/task expansions for the selected period. */
  summary(
    reader: PersistenceReader,
    sessionId: SessionId,
    runId?: RunId,
  ): UsageSummary {
    const where = `session_id = ?${runId ? ' AND run_id = ?' : ''}`
    const parameters = runId ? [sessionId, runId] : [sessionId]
    const rows = reader
      .prepare(
        `SELECT scope, COUNT(*) AS calls, ${sums} FROM session_usage_calls WHERE ${where} GROUP BY scope`,
      )
      .all(...parameters)
    const summary: UsageSummary = { totals: { calls: 0 }, scopes: [] }
    for (const row of rows) {
      const scope = row.scope as LlmUsageRecord['scope']
      const totals = readTotals(row)
      addUsageTotals(summary.totals, totals)
      const models = reader
        .prepare(
          `SELECT provider_id, MAX(provider_label) AS provider_label, model, COUNT(*) AS calls, ${sums}
        FROM session_usage_calls WHERE ${where} AND scope = ? GROUP BY provider_id, model ORDER BY calls DESC, provider_id, model LIMIT 100`,
        )
        .all(...parameters, scope)
      const tasks =
        scope === 'subagent'
          ? reader
              .prepare(
                `SELECT execution_id, MAX(task_name) AS task_name, COUNT(*) AS calls, ${sums}
        FROM session_usage_calls WHERE ${where} AND scope = ? GROUP BY execution_id ORDER BY MAX(ordinal) DESC LIMIT 100`,
              )
              .all(...parameters, scope)
          : []
      summary.scopes.push({
        scope,
        totals,
        models: models.map((model) => ({
          providerId: String(model.provider_id),
          providerLabel: String(model.provider_label),
          model: String(model.model),
          totals: readTotals(model),
        })),
        tasks: tasks.map((task) => ({
          executionId: String(
            task.execution_id,
          ) as UsageSummary['scopes'][number]['tasks'][number]['executionId'],
          name: String(task.task_name),
          totals: readTotals(task),
        })),
      })
    }
    return summary
  }

  /** Restores the header's latest main input and cumulative non-title metrics for one root Run. */
  header(
    reader: PersistenceReader,
    sessionId: SessionId,
    runId?: RunId,
  ): SessionUsageSnapshot['header'] {
    if (!runId) return { main: null, totals: { calls: 0 } }
    const row = reader
      .prepare(
        `SELECT * FROM session_usage_calls WHERE session_id = ? AND run_id = ? AND scope = 'main' ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(sessionId, runId)
    const totals = readTotals(
      reader
        .prepare(
          `SELECT COUNT(*) AS calls, ${sums} FROM session_usage_calls WHERE session_id = ? AND run_id = ? AND scope <> 'title'`,
        )
        .get(sessionId, runId)!,
    )
    if (!row) return { main: null, totals }
    const metrics = readTotals(row)
    const main: NonNullable<SessionUsageSnapshot['header']['main']> = {
      scope: 'main',
      providerId: String(row.provider_id),
      providerLabel: String(row.provider_label),
      model: String(row.model),
      contextWindowTokens: Number(row.context_window_tokens),
      contextWindowSource:
        row.context_window_source as LlmUsageRecord['contextWindowSource'],
    }
    for (const metric of USAGE_METRICS)
      if (metrics[metric] !== undefined) main[metric] = metrics[metric]
    return { main, totals }
  }

  /** Finds the most recently started recorded root Run when no context snapshot exists. */
  latestRun(
    reader: PersistenceReader,
    sessionId: SessionId,
  ): RunId | undefined {
    return reader
      .prepare(
        `SELECT run_id FROM session_usage_calls WHERE session_id = ? GROUP BY run_id ORDER BY MIN(ordinal) DESC LIMIT 1`,
      )
      .get(sessionId)?.run_id as RunId | undefined
  }
}

function readTotals(row: Row): UsageTotals {
  const totals: UsageTotals = { calls: Number(row.calls ?? 0) }
  USAGE_METRICS.forEach((metric, index) => {
    const value = row[columns[index]!]
    if (value !== null && value !== undefined) totals[metric] = Number(value)
  })
  return totals
}
