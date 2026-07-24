import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CallId,
  FileChangeId,
  ProjectId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { createArgsHash } from '../permission/permission-pipeline'
import { ProjectRepository } from '../persistence/project-repository'
import {
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { SessionRepository } from '../persistence/session-repository'
import { createTestDatabase } from '../persistence/test-database'
import { approvedCallBrand } from '../tools/approved-tool-call'
import { hash } from '../tools/file-tool-preconditions'
import { FileChangeExecutionError } from '../session/file-change-execution'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { FileChangeService } from './file-change-service'

describe('FileChangeService mutation records', () => {
  it('commits a private recovery snapshot and publishes only its summary', async () => {
    const setup = await setupService()
    try {
      const prepared = await setup.service.prepareMutation({
        sessionId: setup.sessionId,
        workspace: setup.workspace,
        approvedCall: approvedCreateCall(
          setup.sessionId,
          setup.workspace,
          'durable content',
        ),
        diff: fileDiff('durable content'),
        maximumPayloadBytes: 100_000_000,
      })
      expect(prepared).toBeDefined()
      await writeFile(
        path.join(setup.workspace, 'created.txt'),
        'durable content',
      )
      const outcome = await setup.service.commitMutation({
        workspace: setup.workspace,
        prepared: prepared!,
      })

      expect(outcome).toMatchObject({
        status: 'recorded',
        fileChange: {
          id: 'file-change:test',
          afterExists: true,
          afterHash: hash('durable content'),
        },
      })
      const page = await setup.service.list(setup.sessionId)
      expect(page.records).toHaveLength(1)
      expect(JSON.stringify(page)).not.toContain('beforeContent')
      expect(setup.commits).toEqual([
        expect.objectContaining({
          topic: 'file-change.changed',
          change: {
            mode: 'upsert',
            sessionId: setup.sessionId,
            fileChange: expect.objectContaining({
              id: 'file-change:test',
            }),
          },
        }),
      ])
      expect(JSON.stringify(setup.commits)).not.toContain('beforeContent')
    } finally {
      await setup.dispose()
    }
  })

  it('returns an after-state warning without persisting an unsafe snapshot', async () => {
    const setup = await setupService()
    try {
      const prepared = await setup.service.prepareMutation({
        sessionId: setup.sessionId,
        workspace: setup.workspace,
        approvedCall: approvedCreateCall(
          setup.sessionId,
          setup.workspace,
          'approved content',
        ),
        diff: fileDiff('approved content'),
        maximumPayloadBytes: 100_000_000,
      })
      await writeFile(
        path.join(setup.workspace, 'created.txt'),
        'external content',
      )
      await expect(
        setup.service.commitMutation({
          workspace: setup.workspace,
          prepared: prepared!,
        }),
      ).resolves.toEqual({
        status: 'warning',
        warningCode: 'CHANGE_HISTORY_AFTER_STATE_MISMATCH',
      })
      expect((await setup.service.list(setup.sessionId)).records).toEqual([])
      expect(setup.commits).toEqual([])
    } finally {
      await setup.dispose()
    }
  })

  it('rejects a recovery payload above the frozen byte limit before I/O', async () => {
    const setup = await setupService()
    try {
      const beforeContent = 'b'.repeat(900_000)
      const afterContent = `${beforeContent.slice(0, -1)}a`
      const diff = 'd'.repeat(120_000)
      const error = await setup.service
        .prepareMutation({
          sessionId: setup.sessionId,
          workspace: setup.workspace,
          approvedCall: approvedPatchCall(
            setup.sessionId,
            setup.workspace,
            beforeContent,
            afterContent,
            diff,
          ),
          diff,
          maximumPayloadBytes: 1_000_000,
        })
        .catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(FileChangeExecutionError)
      expect(error).toMatchObject({
        code: 'CHANGE_HISTORY_LIMIT_EXCEEDED',
      })
      expect((await setup.service.list(setup.sessionId)).records).toEqual([])
    } finally {
      await setup.dispose()
    }
  })
})

async function setupService() {
  const testDatabase = await createTestDatabase()
  const workspace = path.join(testDatabase.directory, 'workspace')
  await mkdir(workspace)
  const projectId = 'project:file-change' as ProjectId
  const sessionId = 'session:file-change' as SessionId
  await testDatabase.database.withTransaction((transaction) => {
    new ProjectRepository().insert(
      transaction,
      projectFixture({
        id: projectId,
        path: workspace,
        name: 'FileChange project',
      }),
    )
    new SessionRepository().insert(
      transaction,
      sessionFixture({
        id: sessionId,
        projectId,
        lastSeq: 0,
      }),
    )
  })
  const commits: unknown[] = []
  const coordinator = new ApplicationStateCoordinator({
    database: testDatabase.database,
    backendInstanceId: 'backend:file-change',
    publish: (commit) => {
      commits.push(commit)
    },
  })
  const service = new FileChangeService({
    coordinator,
    createId: () => 'file-change:test' as FileChangeId,
  })
  return {
    testDatabase,
    workspace,
    sessionId,
    commits,
    service,
    dispose: () => testDatabase.dispose(),
  }
}

function approvedPatchCall(
  sessionId: SessionId,
  workspace: string,
  beforeContent: string,
  afterContent: string,
  diff: string,
) {
  const args = {
    path: 'created.txt',
    patch: '@@ -1 +1 @@\n-before\n+after',
  }
  return {
    [approvedCallBrand]: true as const,
    sessionId,
    runId: 'run:file-change' as RunId,
    callId: 'call:file-change-patch' as CallId,
    toolId: 'apply_patch',
    args,
    argsHash: createArgsHash(args),
    resourcePreconditions: [
      {
        kind: 'file' as const,
        operation: 'patch' as const,
        path: 'created.txt',
        absolutePath: path.join(workspace, 'created.txt'),
        parentRealPath: workspace,
        expectedParentId: 'fixture-parent',
        expectedParentExists: true,
        expectedExists: true,
        expectedRealPath: path.join(workspace, 'created.txt'),
        expectedFileId: 'fixture-file',
        expectedContentHash: hash(beforeContent),
        expectedContent: beforeContent,
        expectedResultHash: hash(afterContent),
        expectedResultContent: afterContent,
      },
    ],
    diffHash: hash(diff),
    approvedBy: 'human' as const,
    approvedAt: '2026-07-24T00:00:00.000Z',
  }
}

function approvedCreateCall(
  sessionId: SessionId,
  workspace: string,
  content: string,
) {
  const args = { path: 'created.txt', content }
  const diff = fileDiff(content)
  return {
    [approvedCallBrand]: true as const,
    sessionId,
    runId: 'run:file-change' as RunId,
    callId: 'call:file-change' as CallId,
    toolId: 'create_file',
    args,
    argsHash: createArgsHash(args),
    resourcePreconditions: [
      {
        kind: 'file' as const,
        operation: 'write' as const,
        path: 'created.txt',
        absolutePath: path.join(workspace, 'created.txt'),
        parentRealPath: workspace,
        expectedParentId: 'fixture-parent',
        expectedParentExists: true,
        expectedExists: false,
        expectedResultHash: hash(content),
        expectedResultContent: content,
      },
    ],
    diffHash: hash(diff),
    approvedBy: 'human' as const,
    approvedAt: '2026-07-24T00:00:00.000Z',
  }
}

function fileDiff(content: string): string {
  return [
    '--- a/created.txt',
    '+++ b/created.txt',
    '@@ -1,1 +1,1 @@',
    '-',
    `+${content}`,
    '',
  ].join('\n')
}
