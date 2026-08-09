import { describe, expect, it } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { SubagentExecutionRecord } from './subagent-repository'
import { MessageRepository } from './message-repository'
import { ProjectRepository } from './project-repository'
import {
  FIXTURE_HASH,
  FIXTURE_TIMESTAMP,
  messageFixtures,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { SubagentRepository } from './subagent-repository'
import { createTestDatabase } from './test-database'

const projects = new ProjectRepository()
const sessions = new SessionRepository()
const messages = new MessageRepository()
const subagents = new SubagentRepository()

function execution(
  parentSessionId: SessionId,
  overrides: Partial<SubagentExecutionRecord> = {},
): SubagentExecutionRecord {
  const record: SubagentExecutionRecord = {
    id: 'subagent:fixture' as AgentExecutionId,
    kind: 'subagent',
    name: 'fixture',
    parentSessionId,
    parentRunId: 'run:parent' as RunId,
    parentCallId: 'call:subagent' as CallId,
    specHash: FIXTURE_HASH,
    status: 'preparing',
    route: {
      schemaVersion: 1,
      main: { providerId: 'deepseek', model: 'deepseek-chat' },
    },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  }
  return {
    ...record,
    ...overrides,
    kind: overrides.kind ?? record.kind,
    name: overrides.name ?? record.name,
  }
}

async function seedHiddenSession() {
  const testDatabase = await createTestDatabase()
  const project = projectFixture()
  const parent = sessionFixture({ lastSeq: 0 })
  const child = sessionFixture({
    id: 'session:subagent' as SessionId,
    title: 'Hidden search needle',
    lifecycle: 'active',
    permissionMode: 'readonly',
    lastSeq: 1,
  })
  const record = execution(parent.id)
  const childMessage = messageFixtures(child.id)[0]!
  await testDatabase.database.withTransaction((transaction) => {
    projects.insert(transaction, project)
    sessions.insert(transaction, parent)
    subagents.insert(transaction, record)
    sessions.insert(transaction, child)
    subagents.attachSession(transaction, {
      sessionId: child.id,
      executionId: record.id,
      parentSessionId: parent.id,
      createdAt: FIXTURE_TIMESTAMP,
    })
    messages.insert(transaction, childMessage)
  })
  return { testDatabase, project, parent, child, record }
}

describe('Subagent persistence', () => {
  it('hides child Sessions from every public Session query', async () => {
    const { testDatabase, parent, child } = await seedHiddenSession()
    try {
      const visible = testDatabase.database.read((reader) => ({
        get: sessions.get(reader, child.id),
        getAny: sessions.getAny(reader, child.id),
        list: sessions.listPage(reader).records.map((record) => record.id),
        search: sessions.searchCandidateIds(reader, {
          text: 'Hidden search needle',
        }),
      }))

      expect(visible.get).toBeUndefined()
      expect(visible.getAny?.id).toBe(child.id)
      expect(visible.list).toEqual([parent.id])
      expect(visible.search).toEqual([])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('marks abandoned work interrupted without changing completed results', async () => {
    const { testDatabase, parent, record } = await seedHiddenSession()
    const completed = execution(parent.id, {
      id: 'subagent:completed' as AgentExecutionId,
      parentRunId: 'run:completed' as RunId,
      parentCallId: 'call:completed' as CallId,
      status: 'completed',
      result: { results: { worker: 'done' } },
      completedAt: FIXTURE_TIMESTAMP,
    })
    const swarm = execution(parent.id, {
      id: 'swarm:interrupted' as AgentExecutionId,
      kind: 'swarm',
      name: 'Swarm interrupted',
      parentRunId: 'run:swarm-interrupted' as RunId,
      parentCallId: 'call:swarm-interrupted' as CallId,
      status: 'running',
    })
    const queued = execution(parent.id, {
      id: 'subagent:queued' as AgentExecutionId,
      parentExecutionId: swarm.id,
      childOrdinal: 0,
      name: 'queued',
      parentRunId: swarm.parentRunId,
      parentCallId: swarm.parentCallId,
      status: 'queued',
    })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        subagents.insert(transaction, completed)
        subagents.insert(transaction, swarm)
        subagents.insert(transaction, queued)
        expect(
          subagents.interruptActive(transaction, '2026-07-22T00:01:00.000Z'),
        ).toBe(3)
      })

      const persisted = testDatabase.database.read((reader) => ({
        interrupted: subagents.findByParentCall(reader, record),
        completed: subagents.findByParentCall(reader, completed),
        swarm: subagents.findByParentCall(reader, swarm),
        queued: subagents.getOwned(reader, {
          parentSessionId: parent.id,
          executionId: queued.id,
        })?.record,
      }))
      expect(persisted.interrupted).toMatchObject({
        status: 'interrupted',
        error: { code: 'SUBAGENT_INTERRUPTED' },
      })
      expect(persisted.completed).toMatchObject({
        status: 'completed',
        result: { results: { worker: 'done' } },
      })
      expect(persisted.swarm).toMatchObject({
        status: 'interrupted',
        error: { code: 'SWARM_INTERRUPTED' },
      })
      expect(persisted.queued).toMatchObject({
        status: 'interrupted',
        error: { code: 'SUBAGENT_INTERRUPTED' },
      })
    } finally {
      await testDatabase.dispose()
    }
  })

  it('retains children on archive and cascades them on parent deletion', async () => {
    const { testDatabase, parent, child } = await seedHiddenSession()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        expect(
          sessions.update(
            transaction,
            {
              ...parent,
              lifecycle: 'archived',
              archivedAt: '2026-07-22T00:01:00.000Z',
              revision: 2,
              updatedAt: '2026-07-22T00:01:00.000Z',
            },
            1,
          ),
        ).toBe(true)
      })
      expect(
        testDatabase.database.read((reader) =>
          sessions.getAny(reader, child.id),
        ),
      ).toBeDefined()

      await testDatabase.database.withTransaction((transaction) => {
        expect(sessions.deleteLeaf(transaction, parent.id)).toBe(true)
      })
      const counts = testDatabase.database.read((reader) => ({
        sessions: reader
          .prepare('SELECT count(*) AS count FROM sessions')
          .get(),
        executions: reader
          .prepare('SELECT count(*) AS count FROM subagent_executions')
          .get(),
        ownership: reader
          .prepare('SELECT count(*) AS count FROM subagent_sessions')
          .get(),
        messages: reader
          .prepare('SELECT count(*) AS count FROM messages')
          .get(),
      }))
      expect(counts).toEqual({
        sessions: { count: 0 },
        executions: { count: 0 },
        ownership: { count: 0 },
        messages: { count: 0 },
      })
    } finally {
      await testDatabase.dispose()
    }
  })

  it('cascades hidden state when deleting the owning Project', async () => {
    const { testDatabase, project } = await seedHiddenSession()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        expect(projects.delete(transaction, project.id)).toBe(true)
      })
      expect(
        testDatabase.database.read((reader) =>
          reader
            .prepare('SELECT count(*) AS count FROM subagent_executions')
            .get(),
        ),
      ).toEqual({ count: 0 })
    } finally {
      await testDatabase.dispose()
    }
  })
})
