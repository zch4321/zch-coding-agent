import { describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import type { CallId, MessageId, ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import { canonicalHash } from '../session/canonical-history'
import { createTestDatabase } from '../persistence/test-database'
import { ApplicationError } from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { ProjectService } from './project-service'
import { SessionService, type SessionRuntimeGuard } from './session-service'

const timestamp = '2026-07-23T00:00:00.000Z'
const route = {
  schemaVersion: 1 as const,
  purpose: 'main' as const,
  adapterId: 'deepseek.chat-completions',
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

async function setupServices(runtimeGuard?: SessionRuntimeGuard) {
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
