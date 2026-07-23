import { describe, expect, it } from 'vitest'
import type { MessageId, ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import { decodeMessageRow } from './message-codec'
import { FileChangeRepository } from './file-change-repository'
import { MessageRepository } from './message-repository'
import { ProjectRepository } from './project-repository'
import {
  fileChangeFixture,
  messageFixtures,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { decodeSessionRow } from './session-codec'
import { createTestDatabase } from './test-database'

const projects = new ProjectRepository()
const sessions = new SessionRepository()
const messages = new MessageRepository()
const fileChanges = new FileChangeRepository()

describe('persistence repositories', () => {
  it('round-trips canonical records through a file-backed reopen', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture({
      goal: {
        id: 'goal:fixture',
        objective: 'Verify nullable JSON codec handling',
        status: 'active',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        continuationCount: 0,
      },
      plan: {
        id: 'plan:fixture',
        objective: 'Verify nullable JSON codec handling',
        status: 'active',
        items: [
          {
            id: 'plan-item:fixture',
            title: 'Round-trip through SQLite',
            status: 'in_progress',
            updatedAt: '2026-07-22T00:00:00.000Z',
          },
        ],
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        continuationCount: 0,
      },
    })
    const messageRecords = messageFixtures()
    const fileChange = fileChangeFixture()

    await testDatabase.database.withTransaction((transaction) => {
      projects.insert(transaction, project)
      sessions.insert(transaction, session)
      messages.insertMany(transaction, messageRecords)
      fileChanges.insertWithRetention(transaction, fileChange)
    })
    const databasePath = testDatabase.databasePath
    await testDatabase.database.close()

    const { DatabaseService } = await import('./database-service')
    const reopened = DatabaseService.open({ databasePath, appVersion: 'test' })
    try {
      expect(
        reopened.read((reader) => projects.get(reader, project.id)),
      ).toEqual(project)
      expect(
        reopened.read((reader) => sessions.get(reader, session.id)),
      ).toEqual(session)
      expect(
        reopened.read((reader) =>
          messages.listActiveHistory(reader, session.id),
        ),
      ).toEqual(messageRecords)
      expect(
        reopened.read((reader) =>
          fileChanges.getStored(reader, session.id, fileChange.id),
        ),
      ).toEqual(fileChange)
    } finally {
      await reopened.close()
      await testDatabase.dispose()
    }
  })

  it('enforces Project path and Message seq/request uniqueness', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    const user = messageFixtures()[0]
    if (!user || user.kind !== 'user_input' || !('clientRequestId' in user)) {
      throw new Error('user fixture is missing')
    }
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, session)
        messages.insert(transaction, user)
      })
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          projects.insert(
            transaction,
            projectFixture({ id: 'project:duplicate-path' as ProjectId }),
          )
        }),
      ).rejects.toThrow(/UNIQUE/u)
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          messages.insert(transaction, {
            ...user,
            id: 'message:duplicate-seq' as typeof user.id,
            clientRequestId: 'request:other',
          })
        }),
      ).rejects.toThrow(/UNIQUE/u)
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          messages.insert(transaction, {
            ...user,
            id: 'message:duplicate-request' as typeof user.id,
            seq: 2,
          })
        }),
      ).rejects.toThrow(/UNIQUE/u)
    } finally {
      await testDatabase.dispose()
    }
  })

  it('keeps replayed users in active history but deduplicates UI pages and search', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    const user = messageFixtures()[0]
    if (!user || user.kind !== 'user_input' || !('clientRequestId' in user)) {
      throw new Error('user fixture is missing')
    }
    const replay: MessageRecord = {
      schemaVersion: user.schemaVersion,
      id: 'message:replayed' as MessageId,
      sessionId: user.sessionId,
      seq: 4,
      inHistory: user.inHistory,
      createdAt: user.createdAt,
      kind: 'user_input',
      parts: structuredClone(user.parts),
      metadata: {
        schemaVersion: 1 as const,
        replayedFromMessageId: user.id,
      },
    }
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, session)
        messages.insert(transaction, user)
        messages.insert(transaction, replay)
      })

      expect(
        testDatabase.database.read((reader) =>
          messages.listActiveHistory(reader, session.id),
        ),
      ).toHaveLength(2)
      expect(
        testDatabase.database.read((reader) =>
          messages.listPage(reader, session.id),
        ).records,
      ).toEqual([user])
      expect(
        testDatabase.database.read((reader) =>
          messages.searchText(reader, session.id, {
            text: 'visible search needle',
          }),
        ),
      ).toEqual([user])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('cascades Project removal without touching external workspace data', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, session)
        messages.insertMany(transaction, messageFixtures())
        fileChanges.insertWithRetention(transaction, fileChangeFixture())
      })
      await testDatabase.database.withTransaction((transaction) => {
        expect(projects.delete(transaction, project.id)).toBe(true)
      })
      const counts = testDatabase.database.read((reader) => ({
        projects: reader
          .prepare('SELECT count(*) AS count FROM projects')
          .get(),
        sessions: reader
          .prepare('SELECT count(*) AS count FROM sessions')
          .get(),
        messages: reader
          .prepare('SELECT count(*) AS count FROM messages')
          .get(),
        fileChanges: reader
          .prepare('SELECT count(*) AS count FROM file_changes')
          .get(),
      }))
      expect(counts).toEqual({
        projects: { count: 0 },
        sessions: { count: 0 },
        messages: { count: 0 },
        fileChanges: { count: 0 },
      })
    } finally {
      await testDatabase.dispose()
    }
  })

  it('rolls back cross-repository writes as one application transaction', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    try {
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          projects.insert(transaction, project)
          sessions.insert(transaction, session)
          throw new Error('application transaction failed')
        }),
      ).rejects.toThrow('application transaction failed')
      expect(
        testDatabase.database.read((reader) => projects.list(reader)),
      ).toEqual([])
      expect(
        testDatabase.database.read(
          (reader) => sessions.listPage(reader).records,
        ),
      ).toEqual([])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('pages Sessions and Messages with stable bounded cursors', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const older = sessionFixture({
      id: 'session:older' as SessionId,
      title: 'Older matching session',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
    const newer = sessionFixture({
      id: 'session:newer' as SessionId,
      title: 'Newer matching session',
      updatedAt: '2026-07-22T01:00:00.000Z',
    })
    const messageRecords = messageFixtures(newer.id)
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, older)
        sessions.insert(transaction, newer)
        messages.insertMany(transaction, messageRecords)
      })
      const firstSessions = testDatabase.database.read((reader) =>
        sessions.listPage(reader, { search: 'matching', limit: 1 }),
      )
      expect(firstSessions).toMatchObject({
        hasMore: true,
        records: [{ id: newer.id }],
      })
      if (!firstSessions.hasMore) throw new Error('expected another page')
      const secondSessions = testDatabase.database.read((reader) =>
        sessions.listPage(reader, {
          search: 'matching',
          before: firstSessions.nextBefore,
          limit: 1,
        }),
      )
      expect(secondSessions).toMatchObject({
        hasMore: false,
        records: [{ id: older.id }],
      })

      const firstMessages = testDatabase.database.read((reader) =>
        messages.listPage(reader, newer.id, { limit: 2 }),
      )
      expect(firstMessages.records.map((record) => record.seq)).toEqual([3, 4])
      if (!firstMessages.hasMore) throw new Error('expected older messages')
      const secondMessages = testDatabase.database.read((reader) =>
        messages.listPage(reader, newer.id, {
          beforeSeq: firstMessages.nextBeforeSeq,
          limit: 2,
        }),
      )
      expect(secondMessages.records.map((record) => record.seq)).toEqual([1, 2])
      expect(secondMessages.hasMore).toBe(false)
    } finally {
      await testDatabase.dispose()
    }
  })

  it('searches only bounded user/assistant text parts', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, session)
        messages.insertMany(transaction, messageFixtures())
      })
      expect(
        testDatabase.database
          .read((reader) =>
            messages.searchText(reader, session.id, { text: 'visible' }),
          )
          .map((record) => record.seq),
      ).toEqual([4, 1])
      expect(
        testDatabase.database.read((reader) =>
          messages.searchText(reader, session.id, {
            text: 'hidden-search-needle',
          }),
        ),
      ).toEqual([])
      expect(() =>
        testDatabase.database.read((reader) =>
          messages.searchText(reader, session.id, {
            text: 'x',
            scanLimit: 2_001,
          }),
        ),
      ).toThrow(/scan limit/u)
      expect(() =>
        testDatabase.database.read((reader) =>
          sessions.listPage(reader, { search: ' '.repeat(3) }),
        ),
      ).toThrow(/Session search text/u)
    } finally {
      await testDatabase.dispose()
    }
  })

  it('rejects damaged JSON, enum and boolean rows at codec boundaries', async () => {
    const testDatabase = await createTestDatabase()
    const project = projectFixture()
    const session = sessionFixture()
    const user = messageFixtures()[0]
    if (!user || user.kind !== 'user_input') {
      throw new Error('user fixture is missing')
    }
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, project)
        sessions.insert(transaction, session)
        messages.insert(transaction, user)
      })
      const rows = testDatabase.database.read((reader) => ({
        session: reader.prepare('SELECT * FROM sessions').get()!,
        message: reader.prepare('SELECT * FROM messages').get()!,
      }))
      expect(() =>
        decodeMessageRow({ ...rows.message, parts_json: '{broken' }),
      ).toThrow(/invalid JSON/u)
      expect(() =>
        decodeMessageRow({ ...rows.message, in_history: 2 }),
      ).toThrow(/boolean/u)
      expect(() =>
        decodeSessionRow({ ...rows.session, lifecycle: 'deleted' }),
      ).toThrow(/schema validation/u)
      expect(decodeSessionRow(rows.session)).toEqual(session)
    } finally {
      await testDatabase.dispose()
    }
  })
})
