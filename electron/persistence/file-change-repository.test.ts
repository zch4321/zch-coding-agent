import { describe, expect, it } from 'vitest'
import type { CallId, FileChangeId, SessionId } from '../../shared/ids'
import {
  assertFileChangePayloadWithinLimit,
  DEFAULT_FILE_CHANGE_HISTORY_BYTES,
  FileChangeRepository,
} from './file-change-repository'
import { ProjectRepository } from './project-repository'
import {
  fileChangeFixture,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { createTestDatabase } from './test-database'

describe('FileChangeRepository retention', () => {
  it('retains more than 200 records and pages them without gaps', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository()
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        for (let index = 0; index < 205; index += 1) {
          const timestamp = new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000,
          ).toISOString()
          repository.insertWithRetention(
            transaction,
            fileChangeFixture({
              id: `file-change:${index.toString().padStart(3, '0')}` as FileChangeId,
              callId: `call:${index}` as CallId,
              path: `file-${index}.txt`,
              beforeContent: 'b',
              diff: 'd',
              payloadBytes: 2,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          )
        }
      })
      const first = testDatabase.database.read((reader) =>
        repository.listPage(reader, session.id, { limit: 200 }),
      )
      expect(first.records).toHaveLength(200)
      expect(first.hasMore).toBe(true)
      if (!first.hasMore) throw new Error('Expected another page')
      const second = testDatabase.database.read((reader) =>
        repository.listPage(reader, session.id, {
          before: first.nextBefore,
          limit: 200,
        }),
      )
      expect(second.records).toHaveLength(5)
      expect(second.hasMore).toBe(false)
      const ids = [...first.records, ...second.records].map(
        (record) => record.id,
      )
      expect(new Set(ids).size).toBe(205)
      expect(ids[0]).toBe('file-change:204')
      expect(ids.at(-1)).toBe('file-change:000')
    } finally {
      await testDatabase.dispose()
    }
  })

  it('applies byte retention in the same transaction and keeps snapshots private', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({
      maxPayloadBytes: 12,
    })
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    const first = fileChangeFixture({
      id: 'file-change:first' as FileChangeId,
      callId: 'call:first' as CallId,
      path: 'first.txt',
      beforeContent: '12345',
      diff: '1',
      payloadBytes: 6,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const second = fileChangeFixture({
      id: 'file-change:second' as FileChangeId,
      callId: 'call:second' as CallId,
      path: 'second.txt',
      beforeContent: '123456',
      diff: '1',
      payloadBytes: 7,
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        repository.insertWithRetention(transaction, first)
        repository.insertWithRetention(transaction, second)
      })
      const summaries = testDatabase.database.read(
        (reader) => repository.listPage(reader, session.id).records,
      )
      expect(summaries).toEqual([
        expect.objectContaining({ id: second.id, path: second.path }),
      ])
      expect(JSON.stringify(summaries)).not.toContain('123456')
      expect(
        testDatabase.database.read((reader) =>
          repository.getStored(reader, session.id, second.id),
        ),
      ).toEqual(second)
    } finally {
      await testDatabase.dispose()
    }
  })

  it('applies the documented retention budget globally across Sessions', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({
      maxPayloadBytes: 3,
    })
    const project = projectFixture()
    const firstSession = sessionFixture({ lastSeq: 0 })
    const secondSession = sessionFixture({
      id: 'session:retention-second' as SessionId,
      title: 'Second retention Session',
      lastSeq: 0,
    })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, firstSession)
        new SessionRepository().insert(transaction, secondSession)
        repository.insertWithRetention(
          transaction,
          fileChangeFixture({
            id: 'file-change:retention-first' as FileChangeId,
            sessionId: firstSession.id,
            callId: 'call:retention-first' as CallId,
            beforeContent: 'a',
            diff: 'b',
            payloadBytes: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        )
        repository.insertWithRetention(
          transaction,
          fileChangeFixture({
            id: 'file-change:retention-second' as FileChangeId,
            sessionId: secondSession.id,
            callId: 'call:retention-second' as CallId,
            beforeContent: 'c',
            diff: 'd',
            payloadBytes: 2,
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          }),
        )
      })

      expect(
        testDatabase.database.read(
          (reader) => repository.listPage(reader, firstSession.id).records,
        ),
      ).toEqual([])
      expect(
        testDatabase.database.read(
          (reader) => repository.listPage(reader, secondSession.id).records,
        ),
      ).toHaveLength(1)
    } finally {
      await testDatabase.dispose()
    }
  })

  it('rolls back retention deletes when the surrounding insert transaction fails', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({ maxPayloadBytes: 4 })
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    const first = fileChangeFixture({
      id: 'file-change:rollback-first' as FileChangeId,
      callId: 'call:rollback-first' as CallId,
      beforeContent: 'a',
      diff: 'b',
      payloadBytes: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        repository.insertWithRetention(transaction, first)
      })
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          repository.insertWithRetention(
            transaction,
            fileChangeFixture({
              id: 'file-change:rollback-second' as FileChangeId,
              callId: 'call:rollback-second' as CallId,
              beforeContent: 'abc',
              diff: 'd',
              payloadBytes: 4,
              createdAt: '2026-01-01T00:00:01.000Z',
              updatedAt: '2026-01-01T00:00:01.000Z',
            }),
          )
          throw new Error('rollback after retention')
        }),
      ).rejects.toThrow('rollback after retention')
      expect(
        testDatabase.database.read(
          (reader) => repository.listPage(reader, session.id).records,
        ),
      ).toEqual([expect.objectContaining({ id: first.id })])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('evicts equal timestamps deterministically by id', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({ maxPayloadBytes: 4 })
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    const timestamp = '2026-01-01T00:00:00.000Z'
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        for (const suffix of ['b', 'a', 'c']) {
          repository.insertWithRetention(
            transaction,
            fileChangeFixture({
              id: `file-change:stable-${suffix}` as FileChangeId,
              callId: `call:stable-${suffix}` as CallId,
              path: `${suffix}.txt`,
              beforeContent: suffix,
              diff: suffix,
              payloadBytes: 2,
              createdAt:
                suffix === 'c' ? '2026-01-01T00:00:01.000Z' : timestamp,
              updatedAt: timestamp,
            }),
          )
        }
      })
      expect(
        testDatabase.database
          .read((reader) => repository.listPage(reader, session.id).records)
          .map((record) => record.id),
      ).toEqual(['file-change:stable-c', 'file-change:stable-b'])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('converges to a lowered byte budget on the next insert', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({ maxPayloadBytes: 10 })
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        for (let index = 0; index < 2; index += 1) {
          repository.insertWithRetention(
            transaction,
            fileChangeFixture({
              id: `file-change:lower-${index}` as FileChangeId,
              callId: `call:lower-${index}` as CallId,
              path: `${index}.txt`,
              beforeContent: 'abc',
              diff: 'd',
              payloadBytes: 4,
              createdAt: `2026-01-01T00:00:0${index}.000Z`,
              updatedAt: `2026-01-01T00:00:0${index}.000Z`,
            }),
          )
        }
        repository.insertWithRetention(
          transaction,
          fileChangeFixture({
            id: 'file-change:lower-next' as FileChangeId,
            callId: 'call:lower-next' as CallId,
            path: 'next.txt',
            beforeContent: 'a',
            diff: 'b',
            payloadBytes: 2,
            createdAt: '2026-01-01T00:00:02.000Z',
            updatedAt: '2026-01-01T00:00:02.000Z',
          }),
          5,
        )
      })
      expect(
        testDatabase.database
          .read((reader) => repository.listPage(reader, session.id).records)
          .map((record) => record.id),
      ).toEqual(['file-change:lower-next'])
    } finally {
      await testDatabase.dispose()
    }
  })

  it('rejects a single payload above the default 100 MB product limit', () => {
    expect(DEFAULT_FILE_CHANGE_HISTORY_BYTES).toBe(100_000_000)
    expect(() =>
      assertFileChangePayloadWithinLimit(DEFAULT_FILE_CHANGE_HISTORY_BYTES + 1),
    ).toThrowError(
      expect.objectContaining({ code: 'FILE_CHANGE_LIMIT_EXCEEDED' }),
    )
  })
})
