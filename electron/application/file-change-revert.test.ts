import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileChangeOperation } from '../../shared/file-change'
import type {
  CallId,
  FileChangeId,
  ProjectId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { PersistenceTransaction } from '../persistence/database-service'
import type { StoredFileChangeRecord } from '../persistence/file-change-codec'
import { FileChangeRepository } from '../persistence/file-change-repository'
import { PersistenceError } from '../persistence/persistence-error'
import { ProjectRepository } from '../persistence/project-repository'
import {
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { SessionRepository } from '../persistence/session-repository'
import { createTestDatabase } from '../persistence/test-database'
import { createConfig } from '../session/session-manager-test-support'
import type { FileChangeRevertAccessResult } from '../session/workspace-access-coordinator'
import { hash } from '../tools/file-tool-preconditions'
import { ApplicationError } from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import {
  FileChangeService,
  type FileChangeRuntimeGuard,
} from './file-change-service'

class TestRuntimeGuard implements FileChangeRuntimeGuard {
  mutationReserved = false
  writerReserved = false
  boundProjectId: ProjectId | undefined

  reserveSessionMutation(): string {
    if (this.mutationReserved) {
      throw new ApplicationError('CONFLICT', 'Session is already mutating')
    }
    this.mutationReserved = true
    return 'mutation:1'
  }

  bindSessionMutationProject(
    _sessionId: SessionId,
    operationToken: string,
    projectId: ProjectId,
  ): void {
    if (!this.mutationReserved || operationToken !== 'mutation:1') {
      throw new ApplicationError('CONFLICT', 'Mutation ownership changed')
    }
    this.boundProjectId = projectId
  }

  releaseSessionMutation(): void {
    this.mutationReserved = false
  }

  acquireFileChangeRevertWriter(): FileChangeRevertAccessResult {
    if (this.writerReserved) {
      return {
        acquired: false,
        rejection: {
          reason: 'workspace_writer_active',
          writer: {
            kind: 'provider_run',
            workspace: '/workspace',
            conversationId: 'session:writer',
            sessionId: 'session:writer' as SessionId,
            runId: 'run:writer' as RunId,
          },
        },
      }
    }
    this.writerReserved = true
    return {
      acquired: true,
      release: () => {
        this.writerReserved = false
      },
    }
  }
}

class FailingMarkRepository extends FileChangeRepository {
  override markReverted(
    _transaction: PersistenceTransaction,
    _input: Parameters<FileChangeRepository['markReverted']>[1],
    _expectedRevision: number,
  ): boolean {
    void _transaction
    void _input
    void _expectedRevision
    throw new PersistenceError('DATABASE_IO', 'Injected markReverted failure')
  }
}

describe('FileChangeService revert', () => {
  it.each([
    {
      operation: 'write' as const,
      beforeContent: null,
      afterContent: 'created by agent',
    },
    {
      operation: 'patch' as const,
      beforeContent: 'before patch',
      afterContent: 'after patch',
    },
    {
      operation: 'delete' as const,
      beforeContent: 'deleted by agent',
      afterContent: null,
    },
  ])(
    'safely restores a durable $operation record',
    async ({ operation, beforeContent, afterContent }) => {
      const setup = await setupRevert()
      try {
        const record = await seedChange(setup, {
          operation,
          beforeContent,
          afterContent,
        })
        const result = await setup.service.revert(
          setup.sessionId,
          record.id,
          record.revision,
        )

        expect(result.commit.change).toMatchObject({
          mode: 'upsert',
          sessionId: setup.sessionId,
          fileChange: {
            id: record.id,
            revision: 2,
            revertedAt: expect.any(String),
          },
        })
        const restored = await readFile(
          path.join(setup.workspace, record.path),
          'utf8',
        ).catch((error: unknown) => {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          ) {
            return null
          }
          throw error
        })
        expect(restored).toBe(beforeContent)
        expect(setup.guard.mutationReserved).toBe(false)
        expect(setup.guard.writerReserved).toBe(false)
        await expect(
          setup.service.revert(setup.sessionId, record.id, 1),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      } finally {
        await setup.dispose()
      }
    },
  )

  it('rejects stale revisions and externally changed resources', async () => {
    const setup = await setupRevert()
    try {
      const record = await seedChange(setup, {
        operation: 'patch',
        beforeContent: 'before patch',
        afterContent: 'after patch',
      })
      await expect(
        setup.service.revert(setup.sessionId, record.id, 2),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { currentRevision: 1 },
      })
      await writeFile(
        path.join(setup.workspace, record.path),
        'external replacement',
      )
      await expect(
        setup.service.revert(setup.sessionId, record.id, 1),
      ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
      const unchanged = (await setup.service.list(setup.sessionId)).records[0]!
      expect(unchanged.revision).toBe(1)
      expect(unchanged).not.toHaveProperty('revertedAt')
      expect(
        await readFile(path.join(setup.workspace, record.path), 'utf8'),
      ).toBe('external replacement')
    } finally {
      await setup.dispose()
    }
  })

  it('reports a completed filesystem restore when markReverted fails', async () => {
    const setup = await setupRevert(new FailingMarkRepository())
    try {
      const record = await seedChange(setup, {
        operation: 'patch',
        beforeContent: 'before patch',
        afterContent: 'after patch',
      })
      await expect(
        setup.service.revert(setup.sessionId, record.id, 1),
      ).rejects.toMatchObject({
        code: 'PERSISTENCE_FAILURE',
        details: {
          mutationSucceeded: true,
          warningCode: 'FILE_CHANGE_REVERT_STATE_PERSIST_FAILED',
          fileChangeId: record.id,
        },
      })
      expect(
        await readFile(path.join(setup.workspace, record.path), 'utf8'),
      ).toBe('before patch')
      const unsaved = (await setup.service.list(setup.sessionId)).records[0]!
      expect(unsaved.revision).toBe(1)
      expect(unsaved).not.toHaveProperty('revertedAt')
      await expect(
        setup.service.revert(setup.sessionId, record.id, 1),
      ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
    } finally {
      await setup.dispose()
    }
  })

  it('honors lifecycle and workspace writer conflicts before file I/O', async () => {
    const setup = await setupRevert()
    try {
      const record = await seedChange(setup, {
        operation: 'patch',
        beforeContent: 'before patch',
        afterContent: 'after patch',
      })
      setup.guard.writerReserved = true
      await expect(
        setup.service.revert(setup.sessionId, record.id, 1),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await readFile(path.join(setup.workspace, record.path), 'utf8'),
      ).toBe('after patch')
      setup.guard.writerReserved = false
      setup.guard.mutationReserved = true
      await expect(
        setup.service.revert(setup.sessionId, record.id, 1),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await readFile(path.join(setup.workspace, record.path), 'utf8'),
      ).toBe('after patch')
    } finally {
      await setup.dispose()
    }
  })
})

async function setupRevert(
  fileChanges: FileChangeRepository = new FileChangeRepository(),
) {
  const testDatabase = await createTestDatabase()
  const workspace = path.join(testDatabase.directory, 'workspace')
  await mkdir(workspace)
  const projectId = 'project:revert' as ProjectId
  const sessionId = 'session:revert' as SessionId
  await testDatabase.database.withTransaction((transaction) => {
    new ProjectRepository().insert(
      transaction,
      projectFixture({ id: projectId, path: workspace }),
    )
    new SessionRepository().insert(
      transaction,
      sessionFixture({ id: sessionId, projectId, lastSeq: 0 }),
    )
  })
  const coordinator = new ApplicationStateCoordinator({
    database: testDatabase.database,
    backendInstanceId: 'backend:revert',
  })
  const guard = new TestRuntimeGuard()
  const service = new FileChangeService({
    coordinator,
    configStore: await createConfig(testDatabase.directory),
    fileChanges,
  })
  service.setRuntimeGuard(guard)
  return {
    testDatabase,
    workspace,
    projectId,
    sessionId,
    coordinator,
    fileChanges,
    guard,
    service,
    dispose: () => testDatabase.dispose(),
  }
}

async function seedChange(
  setup: Awaited<ReturnType<typeof setupRevert>>,
  input: {
    operation: FileChangeOperation
    beforeContent: string | null
    afterContent: string | null
  },
): Promise<StoredFileChangeRecord> {
  const pathValue = `${input.operation}.txt`
  const record: StoredFileChangeRecord = {
    schemaVersion: 1,
    id: `file-change:${input.operation}` as FileChangeId,
    sessionId: setup.sessionId,
    callId: `call:${input.operation}` as CallId,
    path: pathValue,
    operation: input.operation,
    diff: `diff:${input.operation}`,
    diffHash: hash(`diff:${input.operation}`),
    diffTruncated: false,
    beforeExists: input.beforeContent !== null,
    beforeHash: hash(input.beforeContent ?? ''),
    beforeContent: input.beforeContent,
    afterExists: input.afterContent !== null,
    afterHash: hash(input.afterContent ?? ''),
    payloadBytes:
      Buffer.byteLength(input.beforeContent ?? '', 'utf8') +
      Buffer.byteLength(`diff:${input.operation}`, 'utf8'),
    revision: 1,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  }
  if (input.afterContent === null) {
    await rm(path.join(setup.workspace, pathValue), { force: true })
  } else {
    await writeFile(path.join(setup.workspace, pathValue), input.afterContent)
  }
  await setup.testDatabase.database.withTransaction((transaction) => {
    setup.fileChanges.insertWithRetention(transaction, record)
  })
  return record
}
