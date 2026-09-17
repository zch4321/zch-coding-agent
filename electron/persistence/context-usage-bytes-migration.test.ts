import { describe, expect, it } from 'vitest'
import type { RunId } from '../../shared/ids'
import { DatabaseService } from './database-service'
import { MessageRepository } from './message-repository'
import { DATABASE_MIGRATIONS } from './migrations'
import { ProjectRepository } from './project-repository'
import {
  messageFixtures,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { SessionUsageRepository } from './session-usage-repository'
import { createTestDatabase } from './test-database'

describe('0015_context_usage_bytes migration', () => {
  it('invalidates estimated context caches while preserving the latest Run, usage calls and history', async () => {
    const legacy = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 14),
    })
    const session = sessionFixture({ lastSeq: 1 })
    const runId = 'run:latest' as RunId
    const usage = new SessionUsageRepository()
    let upgraded: DatabaseService | undefined
    try {
      await legacy.database.withTransaction((tx) => {
        new ProjectRepository().insert(tx, projectFixture())
        new SessionRepository().insert(tx, session)
        new MessageRepository().insert(tx, messageFixtures()[0]!)
        tx.prepare(
          `INSERT INTO session_usage_calls (
          session_id, source_session_id, call_id, run_id, scope, purpose, provider_id, provider_label, model,
          prompt_tokens, completion_tokens, cache_hit_tokens, context_window_tokens, context_window_source, created_at
        ) VALUES (?, ?, 'call:existing', ?, 'main', 'main', 'deepseek', 'DeepSeek', 'deepseek-chat', 100, 10, 0, 4096, 'override', ?)`,
        ).run(session.id, session.id, runId, session.createdAt)
        tx.prepare(
          `INSERT INTO session_context_snapshots
           (session_id, run_id, history_revision, snapshot_json, recipe_json)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          session.id,
          runId,
          session.revision,
          JSON.stringify({ estimatedTokens: 42, categories: [] }),
          JSON.stringify({ tools: { tokens: 20, count: 1, entries: [] } }),
        )
      })
      const readFacts = (db: DatabaseService) =>
        db.read((reader) => ({
          calls: reader.prepare('SELECT * FROM session_usage_calls').all(),
          sessions: reader
            .prepare('SELECT id, revision, last_seq, title FROM sessions')
            .all(),
          messages: reader.prepare('SELECT * FROM messages').all(),
        }))
      const before = readFacts(legacy.database)
      await legacy.database.close()
      upgraded = DatabaseService.open({
        databasePath: legacy.databasePath,
        appVersion: 'context-usage-bytes-migration-test',
      })
      expect(readFacts(upgraded)).toEqual(before)
      expect(
        upgraded.read((reader) => usage.context(reader, session.id)),
      ).toEqual({ runId, revision: 0, snapshot: null, recipe: null })
      expect(
        upgraded.read((reader) => usage.summary(reader, session.id, runId))
          .totals,
      ).toEqual({
        calls: 1,
        promptTokens: 100,
        completionTokens: 10,
        cacheHitTokens: 0,
      })
    } finally {
      await upgraded?.close()
      await legacy.dispose()
    }
  })
})
