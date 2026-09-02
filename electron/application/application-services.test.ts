import { describe, expect, it, vi } from 'vitest'
import { mkdir, realpath } from 'node:fs/promises'
import type { CallId, MessageId, ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import { canonicalHash } from '../session/canonical-history'
import { MessageRepository } from '../persistence/message-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { projectFixture } from '../persistence/repository-fixtures'
import { createTestDatabase } from '../persistence/test-database'
import { ApplicationError } from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { ProjectService, type ProjectRuntimeGuard } from './project-service'
import { SessionService, type SessionRuntimeGuard } from './session-service'

const timestamp = '2026-07-23T00:00:00.000Z'
const route = {
  schemaVersion: 2 as const,
  purpose: 'main' as const,
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'off' as const,
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}

function messageIdentity(
  sessionId: SessionId,
  seq: number,
  id = `message:${seq}`,
) {
  return {
    schemaVersion: 1 as const,
    id: id as MessageId,
    sessionId,
    seq,
    visibility: 'visible' as const,
    inHistory: true,
    createdAt: new Date(Date.parse(timestamp) + seq * 1_000).toISOString(),
  }
}

function firstTurn(
  sessionId: SessionId,
  clientRequestId = 'request:first',
  text = 'hello durable state',
): MessageRecord[] {
  return [
    {
      ...messageIdentity(sessionId, 1),
      kind: 'system_instruction',
      parts: [{ type: 'text', text: 'Stable system instruction' }],
    },
    {
      ...messageIdentity(sessionId, 2),
      kind: 'user_input',
      clientRequestId,
      parts: [{ type: 'text', text }],
      metadata: {
        schemaVersion: 1,
        requestHash: canonicalHash(text),
        submission: { type: 'message' },
      },
    },
  ]
}

function activeSession(
  id: SessionId,
  projectId: ProjectId,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    title: 'Durable session',
    titleSource: 'user',
    lifecycle: 'active',
    permissionMode: 'confirm',
    modelSelection: {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'off',
    },
    goal: null,
    plan: null,
    revision: 1,
    lastSeq: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as SessionRecord
}

async function setupServices(
  runtimeGuard?: SessionRuntimeGuard,
  onDiagnostic?: (message: string, error?: unknown) => void,
) {
  const testDatabase = await createTestDatabase()
  const commits: unknown[] = []
  const coordinator = new ApplicationStateCoordinator({
    database: testDatabase.database,
    backendInstanceId: 'backend:test',
    publish: (commit) => {
      commits.push(commit)
    },
  })
  const projects = new ProjectService({
    coordinator,
    now: () => timestamp,
    createId: () => 'project:test' as ProjectId,
  })
  const sessions = new SessionService({
    coordinator,
    runtimeGuard,
    onDiagnostic,
    now: () => timestamp,
    createMessageId: (() => {
      let value = 0
      return () => `message:fork:${(value += 1)}` as MessageId
    })(),
  })
  const projectCommit = await projects.add({
    path: testDatabase.directory,
    name: 'test',
  })
  const project = projectCommit.commit.change.projects[0]!
  return {
    testDatabase,
    coordinator,
    commits,
    projects,
    sessions,
    project,
  }
}

describe('application-state coordinator and ProjectService', () => {
  it('serializes commits, canonicalizes paths and publishes frozen envelopes', async () => {
    const setup = await setupServices()
    try {
      const [listed, cursor] = await Promise.all([
        setup.projects.list(),
        setup.coordinator.query(() => 'snapshot'),
      ])
      expect(listed).toHaveLength(1)
      expect(listed[0]?.path).toBe(await realpath(setup.testDatabase.directory))
      expect(cursor.cursor).toEqual({
        schemaVersion: 1,
        backendInstanceId: 'backend:test',
        sequence: 1,
      })
      expect(Object.isFrozen(setup.commits[0])).toBe(true)

      await expect(
        setup.projects.add({ path: setup.testDatabase.directory }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        setup.projects.update({
          projectId: setup.project.id,
          expectedRevision: 99,
          patch: { name: 'changed' },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const updated = await setup.projects.update({
        projectId: setup.project.id,
        expectedRevision: 1,
        patch: { name: 'changed' },
      })
      expect(updated.commit.cursor.sequence).toBe(2)
      expect(updated.commit.change.projects[0]).toMatchObject({
        name: 'changed',
        revision: 2,
      })
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('rejects the 513th Project without persisting it', async () => {
    const setup = await setupServices()
    const repository = new ProjectRepository()
    const overflowPath = `${setup.testDatabase.directory}/overflow`
    await mkdir(overflowPath)
    try {
      await setup.testDatabase.database.withTransaction((transaction) => {
        for (let index = 1; index < 512; index += 1) {
          repository.insert(
            transaction,
            projectFixture({
              id: `project:capacity-${index}` as ProjectId,
              path: `C:/capacity/${index}`,
              createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
              updatedAt: new Date(Date.parse(timestamp) + index).toISOString(),
            }),
          )
        }
      })
      const capped = new ProjectService({
        coordinator: setup.coordinator,
        createId: () => 'project:overflow' as ProjectId,
      })

      await expect(
        capped.add({ path: overflowPath, name: 'overflow' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect(
        setup.testDatabase.database.read((reader) => repository.count(reader)),
      ).toBe(512)
      expect(
        setup.testDatabase.database.read((reader) =>
          repository.get(reader, 'project:overflow' as ProjectId),
        ),
      ).toBeUndefined()
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('quiesces and cleans every Project Session around permanent removal', async () => {
    const setup = await setupServices()
    const calls: string[] = []
    const sessionIds = [
      'session:project-first',
      'session:project-second',
    ] as SessionId[]
    const guard: ProjectRuntimeGuard = {
      assertProjectIdle: vi.fn(),
      reserveProjectEviction: () => {
        calls.push('reserve')
        return 'operation-token'
      },
      cancelProjectEviction: vi.fn(),
      quiesceProject: async () => {
        calls.push('quiesce')
        return sessionIds
      },
      cleanupDeletedSessions: async (deleted) => {
        calls.push(`cleanup:${deleted.join(',')}`)
      },
      evictIdleProject: async () => {
        calls.push('evict')
      },
    }
    const projects = new ProjectService({
      coordinator: setup.coordinator,
      runtimeGuard: guard,
    })
    try {
      await projects.remove({
        projectId: setup.project.id,
        expectedRevision: setup.project.revision,
      })
      expect(calls).toEqual([
        'reserve',
        'quiesce',
        `cleanup:${sessionIds.join(',')}`,
        'evict',
      ])
      await expect(projects.get(setup.project.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    } finally {
      await setup.testDatabase.dispose()
    }
  })
})

describe('SessionService durable transactions', () => {
  it('atomically creates the first turn and enforces request idempotency', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:first' as SessionId
      const records = firstTurn(sessionId)
      const record = activeSession(sessionId, setup.project.id)
      const committed = await setup.sessions.commitFirstTurn({
        session: record,
        messages: records,
        requestHash: canonicalHash('hello durable state'),
      })
      expect(committed).toMatchObject({
        outcome: 'committed',
        result: {
          commit: {
            topic: 'session.changed',
            change: {
              session: { revision: 1, lastSeq: 2 },
              messageChange: { mode: 'upsert' },
            },
          },
        },
      })

      await expect(
        setup.sessions.lookupRequest(
          sessionId,
          'request:first',
          canonicalHash('different'),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const duplicate = await setup.sessions.lookupRequest(
        sessionId,
        'request:first',
        canonicalHash('hello durable state'),
      )
      expect(duplicate?.userMessage.seq).toBe(2)

      const assistant: MessageRecord = {
        ...messageIdentity(sessionId, 3),
        kind: 'assistant_turn',
        parts: [{ type: 'text', text: 'durable answer needle' }],
        modelRoute: route,
      }
      const mutation = await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        messages: [assistant],
      })
      expect(mutation.commit.change.session).toMatchObject({
        revision: 2,
        lastSeq: 3,
      })
      await expect(
        setup.sessions.commitMutation({
          sessionId,
          expectedRevision: 1,
          expectedLastSeq: 2,
          messages: [],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await setup.sessions.searchMessages(sessionId, {
          text: 'answer needle',
        }),
      ).toEqual([assistant])
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('rolls compact epochs forward in one invalidate transaction', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:compact' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })
      const system: MessageRecord = {
        ...messageIdentity(sessionId, 3),
        kind: 'system_instruction',
        parts: [{ type: 'text', text: 'Rebuilt system' }],
      }
      const replay: MessageRecord = {
        ...messageIdentity(sessionId, 4),
        kind: 'user_input',
        parts: [{ type: 'text', text: 'hello durable state' }],
        metadata: {
          schemaVersion: 1,
          replayedFromMessageId: 'message:2' as MessageId,
        },
      }
      const summary: MessageRecord = {
        ...messageIdentity(sessionId, 5),
        kind: 'compact_summary',
        parts: [{ type: 'text', text: 'Continuation checkpoint' }],
        metadata: {
          schemaVersion: 1,
          compact: {
            replacesThroughSeq: 2,
            sourceHash: 'a'.repeat(64),
          },
        },
      }
      const compacted = await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        deactivateThroughSeq: 2,
        messages: [system, replay, summary],
        messageChange: 'invalidate',
      })
      expect(compacted.commit.change).toMatchObject({
        session: { revision: 2, lastSeq: 5 },
        messageChange: { mode: 'invalidate', throughSeq: 2 },
      })
      expect(await setup.sessions.listActiveHistory(sessionId)).toEqual([
        system,
        replay,
        summary,
      ])

      await expect(
        setup.sessions.commitMutation({
          sessionId,
          expectedRevision: 1,
          expectedLastSeq: 2,
          messages: [],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect((await setup.sessions.getRecord(sessionId)).lastSeq).toBe(5)
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('rewinds across compact, rejects repeated rewind, and forks only the current branch', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:rewind-compact' as SessionId
      const firstUserId = 'message:rewind-user-1' as MessageId
      const secondUserId = 'message:rewind-user-2' as MessageId
      const initial = activeSession(sessionId, setup.project.id, {
        goal: {
          id: 'goal:rewind',
          objective: 'Rewind safely',
          status: 'paused',
          createdAt: timestamp,
          updatedAt: timestamp,
          continuationCount: 0,
        },
        plan: {
          id: 'plan:rewind',
          objective: 'Rewind safely',
          status: 'rejected',
          items: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          continuationCount: 0,
        },
      })
      const system: MessageRecord = {
        ...messageIdentity(sessionId, 1, 'message:rewind-system'),
        visibility: 'hidden',
        turnId: firstUserId,
        kind: 'system_instruction',
        parts: [{ type: 'text', text: 'Stable system instruction' }],
      }
      const firstUser: MessageRecord = {
        ...messageIdentity(sessionId, 2, firstUserId),
        turnId: firstUserId,
        kind: 'user_input',
        clientRequestId: 'request:rewind-user-1',
        parts: [{ type: 'text', text: 'first durable turn' }],
        metadata: {
          schemaVersion: 1,
          requestHash: canonicalHash('first durable turn'),
          submission: { type: 'message' },
        },
      }
      await setup.sessions.commitFirstTurn({
        session: initial,
        messages: [system, firstUser],
        requestHash: canonicalHash('first durable turn'),
      })
      const firstAssistant: MessageRecord = {
        ...messageIdentity(sessionId, 3, 'message:rewind-assistant-1'),
        turnId: firstUserId,
        kind: 'assistant_turn',
        parts: [{ type: 'text', text: 'first durable answer' }],
        modelRoute: route,
      }
      await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        messages: [firstAssistant],
      })

      const compactSystem: MessageRecord = {
        ...messageIdentity(sessionId, 4, 'message:rewind-compact-system'),
        visibility: 'hidden',
        kind: 'system_instruction',
        parts: [{ type: 'text', text: 'Rebuilt system instruction' }],
      }
      const replay: MessageRecord = {
        ...messageIdentity(sessionId, 5, 'message:rewind-replay'),
        visibility: 'hidden',
        kind: 'user_input',
        parts: [{ type: 'text', text: 'first durable turn' }],
        metadata: {
          schemaVersion: 1,
          replayedFromMessageId: firstUserId,
        },
      }
      const summary: MessageRecord = {
        ...messageIdentity(sessionId, 6, 'message:rewind-summary'),
        visibility: 'hidden',
        kind: 'compact_summary',
        parts: [{ type: 'text', text: 'Compacted first turn' }],
        metadata: {
          schemaVersion: 1,
          compact: {
            replacesThroughSeq: 3,
            sourceHash: 'b'.repeat(64),
          },
        },
      }
      await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 2,
        expectedLastSeq: 3,
        deactivateThroughSeq: 3,
        messages: [compactSystem, replay, summary],
        messageChange: 'invalidate',
      })

      const selectedContext: MessageRecord = {
        ...messageIdentity(sessionId, 7, 'message:rewind-context-2'),
        visibility: 'hidden',
        turnId: secondUserId,
        kind: 'selected_context',
        parts: [{ type: 'text', text: 'Selected context for turn two' }],
        metadata: {
          schemaVersion: 1,
          layer: {
            source: 'selected-context',
            trusted: false,
            editable: false,
            hash: 'c'.repeat(64),
          },
        },
      }
      const secondUser: MessageRecord = {
        ...messageIdentity(sessionId, 8, secondUserId),
        turnId: secondUserId,
        kind: 'user_input',
        clientRequestId: 'request:rewind-user-2',
        parts: [{ type: 'text', text: 'second durable turn' }],
        metadata: {
          schemaVersion: 1,
          requestHash: canonicalHash('second durable turn'),
          submission: { type: 'message' },
        },
      }
      const secondAssistant: MessageRecord = {
        ...messageIdentity(sessionId, 9, 'message:rewind-assistant-2'),
        turnId: secondUserId,
        kind: 'assistant_turn',
        parts: [{ type: 'text', text: 'second durable answer' }],
        modelRoute: route,
      }
      await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 3,
        expectedLastSeq: 6,
        messages: [selectedContext, secondUser, secondAssistant],
      })

      const rewound = await setup.sessions.rewind({
        sessionId,
        expectedRevision: 4,
        messageId: firstAssistant.id,
        boundary: 'before_message',
      })
      expect(rewound.commit.change).toMatchObject({
        session: { revision: 5, goal: null, plan: null },
        messageChange: { mode: 'invalidate_all' },
      })
      const records = await setup.coordinator.query((reader) =>
        new MessageRepository().listAll(reader, sessionId),
      )
      expect(
        records.value
          .filter((record) => record.visibility !== 'superseded')
          .map((record) => record.id),
      ).toEqual([system.id, firstUser.id])
      expect(
        records.value
          .filter((record) => record.inHistory)
          .map((record) => record.id),
      ).toEqual([system.id, firstUser.id])
      expect(
        records.value
          .filter((record) => record.visibility === 'superseded')
          .map((record) => record.id),
      ).toEqual([
        firstAssistant.id,
        compactSystem.id,
        replay.id,
        summary.id,
        selectedContext.id,
        secondUser.id,
        secondAssistant.id,
      ])
      await expect(
        setup.sessions.rewind({
          sessionId,
          expectedRevision: 5,
          messageId: firstAssistant.id,
          boundary: 'before_message',
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

      const fork = await setup.sessions.fork({
        sourceSessionId: sessionId,
        expectedRevision: 5,
        sessionId: 'session:rewind-fork' as SessionId,
      })
      expect(fork.commit.change.messageChange).toMatchObject({
        mode: 'upsert',
      })
      if (fork.commit.change.messageChange.mode !== 'upsert') {
        throw new Error('Expected fork message records')
      }
      expect(fork.commit.change.messageChange.records).toHaveLength(2)
      expect(
        fork.commit.change.messageChange.records.every(
          (record) => record.visibility !== 'superseded',
        ),
      ).toBe(true)
      expect(fork.commit.change.session.parent?.forkedFromSeq).toBe(2)
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('rejects archive while runtime resources are active and releases idle state', async () => {
    let active = true
    let releases = 0
    const guard: SessionRuntimeGuard = {
      assertSessionIdle() {
        if (active) {
          throw new ApplicationError('CONFLICT', 'active run')
        }
      },
      snapshot: () => undefined,
      releaseSession() {
        releases += 1
      },
    }
    const setup = await setupServices(guard)
    try {
      const sessionId = 'session:archive' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })
      await expect(
        setup.sessions.archive({ sessionId, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      active = false
      const archived = await setup.sessions.archive({
        sessionId,
        expectedRevision: 1,
      })
      expect(archived.commit.change.session).toMatchObject({
        lifecycle: 'archived',
        revision: 2,
      })
      expect(releases).toBe(1)
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('restores archived Sessions and permanently deletes archived leaf Sessions', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:restore-delete' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })
      await setup.sessions.archive({ sessionId, expectedRevision: 1 })

      const restored = await setup.sessions.restore({
        sessionId,
        expectedRevision: 2,
      })
      expect(restored.commit.change.session).toMatchObject({
        lifecycle: 'active',
        revision: 3,
      })
      expect(restored.commit.change.session).not.toHaveProperty('archivedAt')

      await expect(
        setup.sessions.deleteArchived({ sessionId, expectedRevision: 3 }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await setup.sessions.archive({ sessionId, expectedRevision: 3 })
      const removed = await setup.sessions.deleteArchived({
        sessionId,
        expectedRevision: 4,
      })
      expect(removed.commit).toMatchObject({
        topic: 'session.removed',
        change: { sessionId, projectId: setup.project.id },
      })
      await expect(setup.sessions.getRecord(sessionId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      const durableCounts = (
        await setup.coordinator.query((reader) => ({
          messages: Number(
            (
              reader
                .prepare(
                  'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
                )
                .get(sessionId) as { count: number }
            ).count,
          ),
        }))
      ).value
      expect(durableCounts).toEqual({ messages: 0 })
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('refuses permanent deletion while fork children still reference the Session', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:delete-parent' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })
      await setup.sessions.fork({
        sourceSessionId: sessionId,
        expectedRevision: 1,
        sessionId: 'session:delete-child' as SessionId,
      })
      await setup.sessions.archive({ sessionId, expectedRevision: 1 })

      await expect(
        setup.sessions.deleteArchived({ sessionId, expectedRevision: 2 }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(setup.sessions.getRecord(sessionId)).resolves.toMatchObject({
        lifecycle: 'archived',
      })
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('keeps a committed update successful when runtime refresh fails', async () => {
    const onDiagnostic = vi.fn()
    const guard: SessionRuntimeGuard = {
      assertSessionIdle() {},
      snapshot: () => undefined,
      releaseSession() {},
      applySessionRecord() {
        throw new ApplicationError('CONFLICT', 'run started after commit')
      },
    }
    const setup = await setupServices(guard, onDiagnostic)
    try {
      const sessionId = 'session:update-refresh' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })

      const updated = await setup.sessions.update({
        sessionId,
        expectedRevision: 1,
        patch: { title: 'Committed title' },
      })

      expect(updated.commit.change.session).toMatchObject({
        title: 'Committed title',
        revision: 2,
      })
      await expect(setup.sessions.getRecord(sessionId)).resolves.toMatchObject({
        title: 'Committed title',
        revision: 2,
      })
      expect(onDiagnostic).toHaveBeenCalledWith(
        `Updated Session ${sessionId} could not refresh its runtime context`,
        expect.objectContaining({ code: 'CONFLICT' }),
      )
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('applies an automatic title without advancing the execution revision', async () => {
    const setup = await setupServices()
    try {
      const sessionId = 'session:model-title' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sessionId, setup.project.id, {
          title: 'Automatic title',
          titleSource: 'auto',
        }),
        messages: firstTurn(sessionId),
        requestHash: canonicalHash('hello durable state'),
      })

      await expect(
        setup.sessions.applyModelTitle({
          sessionId,
          title: 'Generated title',
        }),
      ).resolves.toBe(true)
      await expect(setup.sessions.getRecord(sessionId)).resolves.toMatchObject({
        title: 'Generated title',
        titleSource: 'model',
        revision: 1,
        lastSeq: 2,
      })

      const next = await setup.sessions.commitMutation({
        sessionId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        metadata: { permissionMode: 'readonly' },
        messageChange: 'none',
      })
      expect(next.commit.change.session).toMatchObject({
        title: 'Generated title',
        titleSource: 'model',
        revision: 2,
      })
      await expect(
        setup.sessions.applyModelTitle({
          sessionId,
          title: 'Replacement title',
        }),
      ).resolves.toBe(false)
    } finally {
      await setup.testDatabase.dispose()
    }
  })
})

describe('ordinary Session fork', () => {
  it('remaps derived command references and hides control records in a fork', async () => {
    const setup = await setupServices()
    try {
      const sourceId = 'session:control-source' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sourceId, setup.project.id),
        messages: firstTurn(sourceId),
        requestHash: canonicalHash('hello durable state'),
      })
      const commandId = 'message:control-command' as MessageId
      const command: MessageRecord = {
        ...messageIdentity(sourceId, 3, commandId),
        inHistory: false,
        kind: 'user_input',
        clientRequestId: 'request:control-command',
        parts: [{ type: 'text', text: '/compact focus on safety' }],
        metadata: {
          schemaVersion: 1,
          requestHash: canonicalHash('/compact focus on safety'),
          submission: { type: 'control_command', command: 'compact' },
        },
      }
      const derived: MessageRecord = {
        ...messageIdentity(sourceId, 4, 'message:control-derived'),
        kind: 'user_input',
        parts: [{ type: 'text', text: 'focus on safety' }],
        metadata: {
          schemaVersion: 1,
          derivedFromMessageId: commandId,
          derivation: 'control_command_payload',
        },
      }
      await setup.sessions.commitMutation({
        sessionId: sourceId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        messages: [command, derived],
      })

      await expect(
        setup.sessions.fork({
          sourceSessionId: sourceId,
          expectedRevision: 2,
          sessionId: 'session:invalid-control-fork' as SessionId,
          throughMessageId: commandId,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

      const forkId = 'session:control-fork' as SessionId
      await setup.sessions.fork({
        sourceSessionId: sourceId,
        expectedRevision: 2,
        sessionId: forkId,
      })
      const page = await setup.sessions.listMessages(forkId)
      const clonedCommand = page.records.find(
        (record) =>
          record.kind === 'user_input' &&
          'clientRequestId' in record &&
          record.clientRequestId === 'request:control-command',
      )
      const clonedDerived = page.records.find(
        (record) =>
          record.kind === 'user_input' &&
          record.metadata &&
          'derivedFromMessageId' in record.metadata,
      )
      expect(clonedCommand).toMatchObject({
        inHistory: false,
        metadata: {
          submission: { type: 'control_command', command: 'compact' },
        },
      })
      expect(clonedDerived).toMatchObject({
        inHistory: true,
        metadata: {
          derivedFromMessageId: clonedCommand?.id,
          derivation: 'control_command_payload',
        },
      })
      expect(
        await setup.sessions.searchMessages(forkId, { text: '/compact' }),
      ).toEqual([])
      expect(
        await setup.sessions.searchMessages(forkId, {
          text: 'focus on safety',
        }),
      ).toEqual([clonedDerived])
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('extends an assistant fork point through its terminal tool batch', async () => {
    const setup = await setupServices()
    try {
      const sourceId = 'session:source' as SessionId
      const goal = {
        id: 'goal:source',
        objective: 'Finish source',
        status: 'active' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
        continuationCount: 0,
      }
      await setup.sessions.commitFirstTurn({
        session: activeSession(sourceId, setup.project.id, { goal }),
        messages: firstTurn(sourceId),
        requestHash: canonicalHash('hello durable state'),
      })
      const callId = 'call:fork' as CallId
      const assistant: MessageRecord = {
        ...messageIdentity(sourceId, 3, 'message:assistant'),
        kind: 'assistant_turn',
        parts: [
          {
            type: 'tool_call',
            callId,
            name: 'read_file',
            arguments: { path: 'README.md' },
          },
        ],
        modelRoute: route,
      }
      const result: MessageRecord = {
        ...messageIdentity(sourceId, 4, 'message:result'),
        kind: 'tool_result',
        parts: [
          {
            type: 'tool_result',
            callId,
            content: [{ type: 'text', text: 'README' }],
            isError: false,
          },
        ],
        metadata: {
          schemaVersion: 1,
          tool: {
            name: 'read_file',
            resultProjection: 'model-content.v1',
            status: 'completed',
            truncated: false,
          },
        },
      }
      const final: MessageRecord = {
        ...messageIdentity(sourceId, 5, 'message:final'),
        kind: 'assistant_turn',
        parts: [{ type: 'text', text: 'final answer' }],
        modelRoute: route,
      }
      await setup.sessions.commitMutation({
        sessionId: sourceId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        messages: [assistant, result, final],
      })

      const historicalId = 'session:historical-fork' as SessionId
      const historical = await setup.sessions.fork({
        sourceSessionId: sourceId,
        expectedRevision: 2,
        sessionId: historicalId,
        throughMessageId: assistant.id,
      })
      expect(historical.commit.change.session).toMatchObject({
        id: historicalId,
        title: 'Fork: Durable session',
        lastSeq: 4,
        goal: null,
        plan: null,
        parent: { sessionId: sourceId, forkedFromSeq: 4 },
      })
      const historicalMessages =
        await setup.sessions.listActiveHistory(historicalId)
      expect(historicalMessages.map((message) => message.kind)).toEqual([
        'system_instruction',
        'user_input',
        'assistant_turn',
        'tool_result',
      ])
      expect(
        historicalMessages.every(
          (message) => message.sessionId === historicalId,
        ),
      ).toBe(true)

      const latestId = 'session:latest-fork' as SessionId
      const latest = await setup.sessions.fork({
        sourceSessionId: sourceId,
        expectedRevision: 2,
        sessionId: latestId,
      })
      expect(latest.commit.change.session).toMatchObject({
        id: latestId,
        lastSeq: 5,
        goal,
        parent: { sessionId: sourceId, forkedFromSeq: 5 },
      })
      expect((await setup.sessions.getRecord(sourceId)).revision).toBe(2)
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('remaps replay references and recomputes the latest compact epoch', async () => {
    const setup = await setupServices()
    try {
      const sourceId = 'session:compact-source' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sourceId, setup.project.id),
        messages: firstTurn(sourceId),
        requestHash: canonicalHash('hello durable state'),
      })
      const rebuilt: MessageRecord[] = [
        {
          ...messageIdentity(sourceId, 3, 'message:rebuilt-system'),
          kind: 'system_instruction',
          parts: [{ type: 'text', text: 'new epoch' }],
        },
        {
          ...messageIdentity(sourceId, 4, 'message:replayed-user'),
          kind: 'user_input',
          parts: [{ type: 'text', text: 'hello durable state' }],
          metadata: {
            schemaVersion: 1,
            replayedFromMessageId: 'message:2' as MessageId,
          },
        },
        {
          ...messageIdentity(sourceId, 5, 'message:summary'),
          kind: 'compact_summary',
          parts: [{ type: 'text', text: 'latest checkpoint' }],
          metadata: {
            schemaVersion: 1,
            compact: {
              replacesThroughSeq: 2,
              sourceHash: 'b'.repeat(64),
            },
          },
        },
      ]
      await setup.sessions.commitMutation({
        sessionId: sourceId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        deactivateThroughSeq: 2,
        messages: rebuilt,
        messageChange: 'invalidate',
      })

      const forkId = 'session:compact-fork' as SessionId
      await setup.sessions.fork({
        sourceSessionId: sourceId,
        expectedRevision: 2,
        sessionId: forkId,
      })
      const active = await setup.sessions.listActiveHistory(forkId)
      expect(active.map((message) => message.seq)).toEqual([3, 4, 5])
      const replay = active[1]
      expect(replay?.kind).toBe('user_input')
      if (
        replay?.kind !== 'user_input' ||
        !replay.metadata ||
        !('replayedFromMessageId' in replay.metadata)
      ) {
        throw new Error('Fork replay message is missing')
      }
      expect(replay.metadata.replayedFromMessageId).not.toBe('message:2')
      expect(replay.metadata.replayedFromMessageId).toMatch(/^message:fork:/u)
      expect((await setup.sessions.getRecord(sourceId)).lastSeq).toBe(5)
    } finally {
      await setup.testDatabase.dispose()
    }
  })

  it('rejects a fork larger than the atomic 512-message bound', async () => {
    const setup = await setupServices()
    try {
      const sourceId = 'session:large-source' as SessionId
      await setup.sessions.commitFirstTurn({
        session: activeSession(sourceId, setup.project.id),
        messages: firstTurn(sourceId),
        requestHash: canonicalHash('hello durable state'),
      })
      const middle = Array.from({ length: 510 }, (_, index) => {
        const seq = index + 3
        return {
          ...messageIdentity(sourceId, seq, `message:large:${seq}`),
          kind: 'orchestrator' as const,
          parts: [{ type: 'text' as const, text: `record ${seq}` }],
        }
      })
      await setup.sessions.commitMutation({
        sessionId: sourceId,
        expectedRevision: 1,
        expectedLastSeq: 2,
        messages: middle,
      })
      const overflow: MessageRecord = {
        ...messageIdentity(sourceId, 513, 'message:large:513'),
        kind: 'orchestrator',
        parts: [{ type: 'text', text: 'overflow' }],
      }
      await setup.sessions.commitMutation({
        sessionId: sourceId,
        expectedRevision: 2,
        expectedLastSeq: 512,
        messages: [overflow],
      })

      await expect(
        setup.sessions.fork({
          sourceSessionId: sourceId,
          expectedRevision: 3,
          sessionId: 'session:too-large-fork' as SessionId,
        }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
      await expect(
        setup.sessions.getRecord('session:too-large-fork' as SessionId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await setup.testDatabase.dispose()
    }
  })
})
