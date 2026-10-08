import { describe, expect, it } from 'vitest'
import type { RunId } from '../../shared/ids'
import { DatabaseService } from './database-service'
import { DATABASE_MIGRATIONS } from './migrations'
import { ProjectRepository } from './project-repository'
import { SessionRepository } from './session-repository'
import { SessionUsageRepository } from './session-usage-repository'
import { projectFixture, sessionFixture } from './repository-fixtures'
import { createTestDatabase } from './test-database'

describe('0018_cache_write_usage migration', () => {
  it('keeps legacy cache writes unknown and restores newly reported metrics after reopening', async () => {
    const legacy = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 17),
    })
    const session = sessionFixture()
    const runId = 'run:cache-write' as RunId
    let upgraded: DatabaseService | undefined
    try {
      await legacy.database.withTransaction((tx) => {
        new ProjectRepository().insert(tx, projectFixture())
        new SessionRepository().insert(tx, session)
        tx.prepare(
          `INSERT INTO session_usage_calls (
          session_id, source_session_id, call_id, run_id, scope, purpose,
          provider_id, provider_label, model, prompt_tokens, cache_hit_tokens,
          cache_miss_tokens, context_window_tokens, context_window_source, created_at
        ) VALUES (?, ?, 'legacy', ?, 'main', 'main', 'openai', 'OpenAI', 'gpt-6.1-sol', 100, 20, 80, 256000, 'default', ?)`,
        ).run(session.id, session.id, runId, session.createdAt)
      })
      await legacy.database.close()
      upgraded = DatabaseService.open({
        databasePath: legacy.databasePath,
        appVersion: 'cache-write-test',
      })
      const repository = new SessionUsageRepository()
      expect(
        upgraded.read((reader) => repository.summary(reader, session.id))
          .totals,
      ).toEqual({
        calls: 1,
        promptTokens: 100,
        cacheHitTokens: 20,
        cacheMissTokens: 80,
      })
      expect(
        upgraded.read((reader) =>
          reader
            .prepare('SELECT cache_write_tokens FROM session_usage_calls')
            .get(),
        ),
      ).toEqual({ cache_write_tokens: null })
      await upgraded.withTransaction((tx) => {
        for (const cacheWriteTokens of [0, 30]) {
          repository.insert(tx, {
            sessionId: session.id,
            runId,
            callId: `new:${cacheWriteTokens}`,
            usage: {
              scope: 'main',
              providerId: 'openai',
              providerLabel: 'OpenAI',
              model: 'gpt-6.1-sol',
              promptTokens: 100,
              cacheHitTokens: 20,
              cacheMissTokens: 80,
              cacheWriteTokens,
              contextWindowTokens: 256000,
              contextWindowSource: 'default',
              raw: null,
            },
          })
        }
      })
      await upgraded.close()
      upgraded = DatabaseService.open({
        databasePath: legacy.databasePath,
        appVersion: 'cache-write-reopen',
      })
      const summary = upgraded.read((reader) =>
        repository.summary(reader, session.id, runId),
      )
      expect(summary.totals).toEqual({
        calls: 3,
        promptTokens: 300,
        cacheHitTokens: 60,
        cacheMissTokens: 240,
        cacheWriteTokens: 30,
      })
      expect(summary.scopes[0]?.models[0]?.totals).toEqual(summary.totals)
      expect(
        upgraded.read((reader) => repository.header(reader, session.id, runId))
          .main?.cacheWriteTokens,
      ).toBe(30)
    } finally {
      await upgraded?.close()
      await legacy.dispose()
    }
  })
})
