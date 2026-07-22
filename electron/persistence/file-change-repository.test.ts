import { describe, expect, it } from 'vitest'
import type { CallId, FileChangeId } from '../../shared/ids'
import {
  assertFileChangePayloadWithinLimit,
  FileChangeRepository,
  MAX_FILE_CHANGE_PAYLOAD_BYTES,
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
  it('retains the newest 200 records with the production defaults', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository()
    const project = projectFixture()
    const session = sessionFixture({ lastSeq: 0 })
    try {
      await testDatabase.database.withTransaction((transaction) => {
        new ProjectRepository().insert(transaction, project)
        new SessionRepository().insert(transaction, session)
        for (let index = 0; index < 201; index += 1) {
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
      const summaries = testDatabase.database.read((reader) =>
        repository.listSummaries(reader, session.id),
      )
      expect(summaries).toHaveLength(200)
      expect(summaries.some((record) => record.id === 'file-change:000')).toBe(
        false,
      )
      expect(summaries[0]?.id).toBe('file-change:200')
    } finally {
      await testDatabase.dispose()
    }
  })

  it('applies byte retention in the same transaction and keeps snapshots private', async () => {
    const testDatabase = await createTestDatabase()
    const repository = new FileChangeRepository({
      maxRecords: 10,
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
      const summaries = testDatabase.database.read((reader) =>
        repository.listSummaries(reader, session.id),
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

  it('rejects a single payload above the fixed 50 MB product limit', () => {
    expect(MAX_FILE_CHANGE_PAYLOAD_BYTES).toBe(50_000_000)
    expect(() =>
      assertFileChangePayloadWithinLimit(MAX_FILE_CHANGE_PAYLOAD_BYTES + 1),
    ).toThrowError(
      expect.objectContaining({ code: 'FILE_CHANGE_LIMIT_EXCEEDED' }),
    )
  })
})
