import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { LlmUsageRecord } from '../../shared/usage'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { DurableCommitEnvelope } from '../../shared/domain-state-api'
import { Value } from '@sinclair/typebox/value'
import { SessionUsageSnapshotSchema } from '../../shared/session-usage'
import { DatabaseService } from '../persistence/database-service'
import {
  createTestDatabase,
  type TestDatabase,
} from '../persistence/test-database'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import { MessageRepository } from '../persistence/message-repository'
import { SubagentRepository } from '../persistence/subagent-repository'
import {
  messageFixtures,
  projectFixture,
  sessionFixture,
  FIXTURE_TIMESTAMP,
  FIXTURE_HASH,
} from '../persistence/repository-fixtures'
import { SessionUsageRepository } from '../persistence/session-usage-repository'
import type { SessionState } from '../session/session-types'
import {
  appendProviderCompactSummary,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { SessionUsageService } from './session-usage-service'

const sessionId = sessionFixture().id
const runId = 'run:usage' as RunId
const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'off',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}
const metric: LlmUsageRecord = {
  scope: 'main',
  providerId: 'deepseek',
  providerLabel: 'DeepSeek',
  model: 'deepseek-chat',
  promptTokens: 100,
  completionTokens: 10,
  cacheHitTokens: 40,
  cacheMissTokens: 60,
  contextWindowTokens: 4096,
  contextWindowSource: 'override',
  raw: { secret: 'not-persisted' },
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const testDb = await createTestDatabase()
  cleanups.push(() => testDb.dispose())
  const commits: DurableCommitEnvelope[] = []
  const coordinator = new ApplicationStateCoordinator({
    database: testDb.database,
    publish: (commit) => {
      commits.push(commit)
    },
  })
  cleanups.push(() => coordinator.close())
  const onDiagnostic = vi.fn()
  const service = new SessionUsageService({
    coordinator,
    onDiagnostic,
  })
  await testDb.database.withTransaction((tx) => {
    new ProjectRepository().insert(tx, projectFixture())
    new SessionRepository().insert(tx, sessionFixture({ lastSeq: 1 }))
    new MessageRepository().insert(tx, messageFixtures()[0]!)
  })
  return { testDb, coordinator, service, commits, onDiagnostic }
}

async function attachChild(testDb: TestDatabase) {
  const childId = 'session:child' as SessionId
  await testDb.database.withTransaction((tx) => {
    const subagents = new SubagentRepository()
    subagents.insert(tx, {
      id: 'subagent:usage' as AgentExecutionId,
      kind: 'subagent',
      name: 'Investigate parser',
      parentSessionId: sessionId,
      parentRunId: runId,
      parentCallId: 'call:delegate' as CallId,
      specHash: FIXTURE_HASH,
      status: 'completed',
      route: {
        schemaVersion: 1,
        main: { providerId: 'deepseek', model: 'deepseek-chat' },
      },
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      completedAt: FIXTURE_TIMESTAMP,
    })
    new SessionRepository().insert(
      tx,
      sessionFixture({ id: childId, lastSeq: 0 }),
    )
    subagents.attachSession(tx, {
      sessionId: childId,
      executionId: 'subagent:usage' as AgentExecutionId,
      parentSessionId: sessionId,
      createdAt: FIXTURE_TIMESTAMP,
    })
  })
  return childId
}

function state(currentRunId = runId): SessionState {
  return {
    sessionId,
    visibility: 'public',
    activeRun: {
      runId: currentRunId,
      routes: {
        main: { snapshot: route, modelProfile: { contextWindowTokens: 4096 } },
      },
    },
  } as SessionState
}

describe('durable Session usage', () => {
  it('selects a newly started Run even when only its failed deferred compression reports usage', async () => {
    const { service } = await setup()
    await service.capture(state())
    const failedRun = 'run:failed-compact' as RunId
    await service.startRun(sessionId, failedRun)
    await service.record({
      sessionId,
      runId: failedRun,
      callId: 'compact',
      usage: { ...metric, scope: 'compression' },
    })
    await service.record({
      sessionId,
      runId,
      callId: 'late-title',
      usage: { ...metric, scope: 'title' },
    })
    const snapshot = await service.get(sessionId)
    expect(snapshot.currentRun).toMatchObject({
      runId: failedRun,
      summary: { totals: { calls: 1 }, scopes: [{ scope: 'compression' }] },
    })
    expect(snapshot.context?.runId).toBe(runId)
    expect(snapshot.header.main).toBeNull()
  })

  it('keeps usage queryable if rewind restores a context incompatible with the saved Provider route', async () => {
    const { service, testDb } = await setup()
    await service.capture(state())
    await service.record({ sessionId, runId, callId: 'main', usage: metric })
    const restored: CanonicalHistoryState = {
      sessionId,
      history: [],
      nextMessageSeq: 2,
    }
    const checkpoint = appendProviderCompactSummary(restored, {
      route: { ...route, providerId: 'earlier-provider' },
      payload: {
        schemaVersion: 1,
        providerType: route.providerType,
        format: 'summary-text.v1',
        data: { text: 'old checkpoint' },
      },
      sourceHash: FIXTURE_HASH,
      replacesThroughSeq: 1,
    })
    await testDb.database.withTransaction((tx) => {
      tx.prepare('UPDATE messages SET in_history = 0 WHERE session_id = ?').run(
        sessionId,
      )
      new MessageRepository().insert(tx, checkpoint)
      tx.prepare(
        'UPDATE sessions SET revision = 2, last_seq = 2 WHERE id = ?',
      ).run(sessionId)
    })
    const snapshot = await service.get(sessionId)
    expect(snapshot.context).toBeNull()
    expect(snapshot.all.totals.calls).toBe(1)
    expect((await service.get(sessionId)).all).toEqual(snapshot.all)
  })
  it('does not backfill messages, deduplicates calls, retains missing metrics and leaves Session metadata untouched', async () => {
    const { service, testDb, commits, onDiagnostic } = await setup()
    expect((await service.get(sessionId)).all.totals).toEqual({ calls: 0 })
    const record = { sessionId, runId, callId: 'call:one', usage: metric }
    await service.record(record)
    await service.record(record)
    await service.record({
      ...record,
      callId: 'call:empty',
      usage: {
        ...metric,
        promptTokens: undefined,
        completionTokens: undefined,
        cacheHitTokens: undefined,
        cacheMissTokens: undefined,
      },
    })
    await service.record({
      ...record,
      callId: 'call:zero',
      usage: {
        ...metric,
        scope: 'approval',
        promptTokens: undefined,
        completionTokens: 0,
        cacheHitTokens: undefined,
        cacheMissTokens: undefined,
      },
    })
    const snapshot = await service.get(sessionId)
    expect(snapshot.all.totals).toEqual({
      calls: 2,
      promptTokens: 100,
      completionTokens: 10,
      cacheHitTokens: 40,
      cacheMissTokens: 60,
    })
    expect(
      snapshot.all.scopes.find((group) => group.scope === 'approval')?.totals,
    ).toEqual({ calls: 1, completionTokens: 0 })
    expect(snapshot.header.main).toMatchObject({ promptTokens: 100 })
    expect(Value.Check(SessionUsageSnapshotSchema, snapshot)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('not-persisted')
    expect(
      testDb.database.read((db) =>
        db
          .prepare('SELECT revision, updated_at FROM sessions WHERE id = ?')
          .get(sessionId),
      ),
    ).toEqual({ revision: 1, updated_at: FIXTURE_TIMESTAMP })
    const row = testDb.database.read((db) =>
      db.prepare('SELECT * FROM session_usage_calls LIMIT 1').get(),
    )
    expect(JSON.stringify(row)).not.toContain('not-persisted')
    expect(commits.map((commit) => commit.topic)).toEqual([
      'session.usage.changed',
      'session.usage.changed',
    ])
    expect(onDiagnostic).not.toHaveBeenCalled()
  })

  it('keeps late child costs on the launching root Run and excludes forwarded summaries', async () => {
    const { service, testDb } = await setup()
    const childId = await attachChild(testDb)
    await service.record({ sessionId, runId, callId: 'first', usage: metric })
    await service.capture(state('run:new' as RunId))
    await service.record({
      sessionId: childId,
      runId: 'run:hidden' as RunId,
      callId: 'child-main',
      usage: metric,
    })
    await service.record({
      sessionId: childId,
      runId: 'run:hidden' as RunId,
      callId: 'child-compact',
      usage: { ...metric, scope: 'compression' },
    })
    await service.record({
      sessionId,
      runId,
      callId: 'forward',
      usage: { ...metric, scope: 'subagent' },
    })
    const snapshot = await service.get(sessionId)
    expect(snapshot.currentRun?.runId).toBe('run:new')
    expect(snapshot.currentRun?.summary.totals.calls).toBe(0)
    expect(snapshot.all.totals.calls).toBe(3)
    expect(
      snapshot.all.scopes.find((group) => group.scope === 'subagent'),
    ).toMatchObject({
      totals: { calls: 2, promptTokens: 200 },
      tasks: [{ name: 'Investigate parser', totals: { calls: 2 } }],
    })
    expect(
      snapshot.all.scopes.some((group) => group.scope === 'compression'),
    ).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain(childId)
    await expect(service.get(childId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await testDb.database.withTransaction((tx) => {
      tx.prepare('DELETE FROM sessions WHERE id = ?').run(childId)
    })
    expect((await service.get(sessionId)).all.totals.calls).toBe(3)
    await testDb.database.withTransaction((tx) => {
      tx.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    })
    expect(
      testDb.database.read(
        (db) =>
          db.prepare('SELECT COUNT(*) AS n FROM session_usage_calls').get()?.n,
      ),
    ).toBe(0)
  })

  it('restores context and usage after reopening SQLite, and recomputes only changed history', async () => {
    const { service, testDb, coordinator, onDiagnostic } = await setup()
    await service.record({ sessionId, runId, callId: 'main', usage: metric })
    await service.record({
      sessionId,
      runId,
      callId: 'title',
      usage: { ...metric, scope: 'title' },
    })
    await service.capture(state())
    const before = await service.get(sessionId)
    expect(before.context?.totalBytes).toBeGreaterThan(0)
    expect(before.all.totals.calls).toBe(2)
    expect(before.header.totals.calls).toBe(1)
    expect(onDiagnostic).not.toHaveBeenCalled()
    await coordinator.close()
    await testDb.database.close()
    const reopened = DatabaseService.open({
      databasePath: testDb.databasePath,
      appVersion: 'test',
    })
    cleanups.push(() => reopened.close())
    const nextCoordinator = new ApplicationStateCoordinator({
      database: reopened,
    })
    cleanups.push(() => nextCoordinator.close())
    const next = new SessionUsageService({
      coordinator: nextCoordinator,
    })
    expect(await next.get(sessionId)).toEqual(before)
    await reopened.withTransaction((tx) => {
      const record = messageFixtures()[3]!
      new MessageRepository().insert(tx, record)
      tx.prepare(
        'UPDATE sessions SET revision = 2, last_seq = 4 WHERE id = ?',
      ).run(sessionId)
    })
    const after = await next.get(sessionId)
    expect(after.context?.totalBytes).toBeGreaterThan(
      before.context!.totalBytes,
    )
    expect(after.all).toEqual(before.all)
    expect(
      reopened.read(
        (db) => new SessionUsageRepository().context(db, sessionId)?.revision,
      ),
    ).toBe(2)
  })
})
