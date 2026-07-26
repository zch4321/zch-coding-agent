import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { FileChangeCommandResult } from '../../shared/domain-state-api'
import type {
  FileChangeListCursor,
  FileChangePage,
} from '../../shared/file-change'
import type { FileChangeId, ProjectId, SessionId } from '../../shared/ids'
import {
  toFileChangeSummary,
  type StoredFileChangeRecord,
} from '../persistence/file-change-codec'
import {
  assertFileChangePayloadWithinLimit,
  FileChangeRepository,
} from '../persistence/file-change-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import type { PersistenceReader } from '../persistence/database-service'
import type {
  FileChangeExecutionPort,
  FileChangeMutationOutcome,
  PreparedFileChange,
} from '../session/file-change-execution'
import { FileChangeExecutionError } from '../session/file-change-execution'
import { isFileDiffTruncated } from '../tools/file-tool-diff'
import type { FilePrecondition } from '../tools/file-tool-types'
import { ApplicationError } from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import {
  assertFileContentState,
  FileChangeResourceError,
  readFileContentState,
  restoreFileContent,
  sha256,
} from './file-change-filesystem'
import type { FileChangeRevertAccessResult } from '../session/workspace-access-coordinator'

const FILE_CHANGE_TOOL_OPERATIONS = {
  create_file: 'write',
  apply_patch: 'patch',
  delete_file: 'delete',
} as const

export interface FileChangeServiceOptions {
  coordinator: ApplicationStateCoordinator
  fileChanges?: FileChangeRepository
  sessions?: SessionRepository
  projects?: ProjectRepository
  now?: () => string
  createId?: () => FileChangeId
  onDiagnostic?: (message: string, error?: unknown) => void
}

export interface FileChangeRuntimeGuard {
  reserveSessionMutation(sessionId: SessionId): string
  bindSessionMutationProject(
    sessionId: SessionId,
    operationToken: string,
    projectId: ProjectId,
  ): void
  releaseSessionMutation(sessionId: SessionId, operationToken: string): void
  acquireFileChangeRevertWriter(input: {
    workspace: string
    sessionId: SessionId
    operationId: string
  }): FileChangeRevertAccessResult
}

/** Provides file change operations. */
export class FileChangeService implements FileChangeExecutionPort {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #fileChanges: FileChangeRepository
  readonly #sessions: SessionRepository
  readonly #projects: ProjectRepository
  readonly #now: () => string
  readonly #createId: () => FileChangeId
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  #runtimeGuard: FileChangeRuntimeGuard | undefined

  constructor(options: FileChangeServiceOptions) {
    this.#coordinator = options.coordinator
    this.#fileChanges = options.fileChanges ?? new FileChangeRepository()
    this.#sessions = options.sessions ?? new SessionRepository()
    this.#projects = options.projects ?? new ProjectRepository()
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId =
      options.createId ?? (() => `file-change:${randomUUID()}` as FileChangeId)
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Sets runtime guard. */
  setRuntimeGuard(runtimeGuard: FileChangeRuntimeGuard): void {
    if (this.#runtimeGuard) {
      throw new Error('FileChange runtime guard is already configured')
    }
    this.#runtimeGuard = runtimeGuard
  }

  /** Lists the currently available records. */
  async list(
    sessionId: SessionId,
    query: { before?: FileChangeListCursor; limit?: number } = {},
  ): Promise<FileChangePage> {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#sessions.get(reader, sessionId)) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        return this.#fileChanges.listPage(reader, sessionId, query)
      })
    ).value
  }

  /** Prepares mutation. */
  async prepareMutation(
    input: Parameters<FileChangeExecutionPort['prepareMutation']>[0],
  ): Promise<PreparedFileChange | undefined> {
    const operation =
      FILE_CHANGE_TOOL_OPERATIONS[
        input.approvedCall.toolId as keyof typeof FILE_CHANGE_TOOL_OPERATIONS
      ]
    if (!operation) return undefined
    const precondition = requireFilePrecondition(
      input.approvedCall.resourcePreconditions,
      operation,
    )
    const beforeContent = precondition.expectedExists
      ? requireText(precondition.expectedContent, 'before content')
      : null
    const afterContent = requireText(
      precondition.expectedResultContent,
      'expected result content',
    )
    const beforeHash = sha256(beforeContent ?? '')
    const beforeMode = precondition.expectedExists
      ? requireFileMode(precondition.expectedMode)
      : null
    const afterHash = sha256(afterContent)
    const diffHash = sha256(input.diff)
    if (
      beforeHash !== (precondition.expectedContentHash ?? beforeHash) ||
      afterHash !== precondition.expectedResultHash ||
      diffHash !== input.approvedCall.diffHash
    ) {
      throw new FileChangeExecutionError(
        'RESOURCE_CHANGED',
        'Approved file change metadata no longer matches its content',
      )
    }
    const payloadBytes =
      Buffer.byteLength(beforeContent ?? '', 'utf8') +
      Buffer.byteLength(input.diff, 'utf8')
    const maximumPayloadBytes = input.maximumPayloadBytes
    try {
      assertFileChangePayloadWithinLimit(payloadBytes, maximumPayloadBytes)
    } catch (error) {
      throw new FileChangeExecutionError(
        'CHANGE_HISTORY_LIMIT_EXCEEDED',
        `File change recovery payload exceeds ${maximumPayloadBytes} bytes`,
        error,
      )
    }

    await this.#assertOwnership(input.sessionId, input.workspace)
    return {
      id: this.#createId(),
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      callId: input.approvedCall.callId,
      path: precondition.path,
      operation,
      diff: input.diff,
      diffHash,
      diffTruncated: isFileDiffTruncated(input.diff),
      beforeExists: precondition.expectedExists,
      beforeMode,
      beforeHash,
      beforeContent,
      afterExists: operation !== 'delete',
      afterHash,
      payloadBytes,
      maximumPayloadBytes,
    }
  }

  /** Commits mutation. */
  async commitMutation(input: {
    workspace: string
    prepared: PreparedFileChange
  }): Promise<FileChangeMutationOutcome> {
    try {
      const after = await readFileContentState(
        input.workspace,
        input.prepared.path,
      )
      assertFileContentState(
        after,
        input.prepared.afterExists,
        input.prepared.afterHash,
      )
    } catch (error) {
      if (error instanceof FileChangeResourceError) {
        this.#onDiagnostic(
          'File change after-state no longer matches the approved mutation',
          error,
        )
        return {
          status: 'warning',
          warningCode: 'CHANGE_HISTORY_AFTER_STATE_MISMATCH',
        }
      }
      this.#onDiagnostic('Failed to verify file change after-state', error)
      return {
        status: 'warning',
        warningCode: 'CHANGE_HISTORY_AFTER_STATE_MISMATCH',
      }
    }

    const timestamp = this.#now()
    const stored: StoredFileChangeRecord = {
      schemaVersion: 1,
      id: input.prepared.id,
      sessionId: input.prepared.sessionId,
      assistantMessageId: input.prepared.assistantMessageId,
      callId: input.prepared.callId,
      workspacePath: input.workspace,
      path: input.prepared.path,
      operation: input.prepared.operation,
      diff: input.prepared.diff,
      diffHash: input.prepared.diffHash,
      diffTruncated: input.prepared.diffTruncated,
      beforeExists: input.prepared.beforeExists,
      beforeMode: input.prepared.beforeMode,
      beforeHash: input.prepared.beforeHash,
      beforeContent: input.prepared.beforeContent,
      afterExists: input.prepared.afterExists,
      afterHash: input.prepared.afterHash,
      payloadBytes: input.prepared.payloadBytes,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      await this.#assertOwnership(input.prepared.sessionId, input.workspace)
      await this.#coordinator.command('file-change.changed', (transaction) => {
        const { retentionApplied } = this.#fileChanges.insertWithRetention(
          transaction,
          stored,
          input.prepared.maximumPayloadBytes,
        )
        return retentionApplied
          ? { mode: 'invalidate_all' as const }
          : {
              mode: 'upsert' as const,
              sessionId: stored.sessionId,
              fileChange: toFileChangeSummary(stored),
            }
      })
      return {
        status: 'recorded',
        fileChange: toFileChangeSummary(stored),
      }
    } catch (error) {
      this.#onDiagnostic('Failed to persist durable file change', error)
      return {
        status: 'warning',
        warningCode: 'CHANGE_HISTORY_PERSIST_FAILED',
      }
    }
  }

  async #assertOwnership(
    sessionId: SessionId,
    workspace: string,
  ): Promise<void> {
    await this.#coordinator.query((reader) => {
      const session = this.#sessions.get(reader, sessionId)
      if (!session) {
        throw new ApplicationError('NOT_FOUND', 'Session was not found')
      }
      if (session.lifecycle !== 'active') {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Archived Session cannot record file changes',
        )
      }
      const project = this.#projects.get(reader, session.projectId)
      if (!project) {
        throw new ApplicationError('NOT_FOUND', 'Project was not found')
      }
      if (normalizePath(project.path) !== normalizePath(workspace)) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'File change workspace does not match its durable Project',
        )
      }
    })
  }

  /** Returns or updates revert state. */
  async revert(
    sessionId: SessionId,
    fileChangeId: FileChangeId,
    expectedRevision: number,
  ): Promise<FileChangeCommandResult> {
    const runtimeGuard = this.#runtimeGuard
    if (!runtimeGuard) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'File change revert runtime is not initialized',
      )
    }
    const operationToken = runtimeGuard.reserveSessionMutation(sessionId)
    const operationId = `file-change-revert:${randomUUID()}`
    let releaseWriter: (() => void) | undefined
    try {
      const initial = (
        await this.#coordinator.query((reader) =>
          this.#readRevertTarget(
            reader,
            sessionId,
            fileChangeId,
            expectedRevision,
          ),
        )
      ).value
      runtimeGuard.bindSessionMutationProject(
        sessionId,
        operationToken,
        initial.projectId,
      )
      const writer = runtimeGuard.acquireFileChangeRevertWriter({
        workspace: initial.workspace,
        sessionId,
        operationId,
      })
      if (!writer.acquired) {
        throw new ApplicationError(
          'CONFLICT',
          'Another operation is modifying this workspace',
          {
            details: {
              writerKind: writer.rejection.writer.kind,
            },
          },
        )
      }
      releaseWriter = writer.release

      const target = (
        await this.#coordinator.query((reader) =>
          this.#readRevertTarget(
            reader,
            sessionId,
            fileChangeId,
            expectedRevision,
          ),
        )
      ).value
      try {
        await restoreFileContent({
          workspace: target.workspace,
          path: target.record.path,
          beforeExists: target.record.beforeExists,
          beforeContent: target.record.beforeContent,
          beforeMode: target.record.beforeMode,
          afterExists: target.record.afterExists,
          afterHash: target.record.afterHash,
        })
      } catch (error) {
        if (error instanceof FileChangeResourceError) {
          throw new ApplicationError('RESOURCE_CHANGED', error.message, {
            cause: error,
          })
        }
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'The file change could not be reverted',
          { cause: error },
        )
      }
      try {
        const timestamp = this.#now()
        return await this.#coordinator.command(
          'file-change.changed',
          (transaction) => {
            const current = this.#readRevertTarget(
              transaction,
              sessionId,
              fileChangeId,
              expectedRevision,
            ).record
            const reverted: StoredFileChangeRecord = {
              ...current,
              revision: current.revision + 1,
              revertedAt: timestamp,
              updatedAt: timestamp,
            }
            if (
              !this.#fileChanges.markReverted(
                transaction,
                {
                  sessionId,
                  id: fileChangeId,
                  revision: reverted.revision,
                  revertedAt: timestamp,
                  updatedAt: timestamp,
                },
                expectedRevision,
              )
            ) {
              throw new ApplicationError(
                'CONFLICT',
                'FileChange revision changed before revert commit',
              )
            }
            return {
              mode: 'upsert',
              sessionId,
              fileChange: toFileChangeSummary(reverted),
            }
          },
        )
      } catch (error) {
        this.#onDiagnostic(
          'File was reverted but durable FileChange state was not saved',
          error,
        )
        throw new ApplicationError(
          'PERSISTENCE_FAILURE',
          'The file was reverted but its durable state was not saved',
          {
            details: {
              mutationSucceeded: true,
              warningCode: 'FILE_CHANGE_REVERT_STATE_PERSIST_FAILED',
              fileChangeId,
            },
            cause: error,
          },
        )
      }
    } finally {
      releaseWriter?.()
      runtimeGuard.releaseSessionMutation(sessionId, operationToken)
    }
  }

  #readRevertTarget(
    reader: PersistenceReader,
    sessionId: SessionId,
    fileChangeId: FileChangeId,
    expectedRevision: number,
  ): {
    projectId: ProjectId
    workspace: string
    record: StoredFileChangeRecord
  } {
    const session = this.#sessions.get(reader, sessionId)
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session was not found')
    }
    if (session.lifecycle !== 'active') {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Archived Session cannot revert file changes',
      )
    }
    const project = this.#projects.get(reader, session.projectId)
    if (!project) {
      throw new ApplicationError('NOT_FOUND', 'Project was not found')
    }
    const record = this.#fileChanges.getStored(reader, sessionId, fileChangeId)
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'FileChange was not found')
    }
    if (record.revertedAt) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'FileChange was already reverted',
      )
    }
    if (record.revision !== expectedRevision) {
      throw new ApplicationError('CONFLICT', 'FileChange revision changed', {
        details: { currentRevision: record.revision },
      })
    }
    if (normalizePath(record.workspacePath) !== normalizePath(project.path)) {
      throw new ApplicationError(
        'RESOURCE_CHANGED',
        'FileChange belongs to a different Project workspace',
      )
    }
    return {
      projectId: project.id,
      workspace: project.path,
      record,
    }
  }
}

function requireFilePrecondition(
  preconditions: readonly FilePrecondition[],
  operation: PreparedFileChange['operation'],
): FilePrecondition {
  const matches = preconditions.filter((candidate) => candidate.kind === 'file')
  if (matches.length !== 1 || matches[0]?.operation !== operation) {
    throw new FileChangeExecutionError(
      'RESOURCE_CHANGED',
      'Approved file mutation must contain exactly one matching precondition',
    )
  }
  return matches[0]
}

function requireText(value: string | undefined, label: string): string {
  if (value !== undefined) return value
  throw new FileChangeExecutionError(
    'RESOURCE_CHANGED',
    `Approved file mutation is missing ${label}`,
  )
}

function requireFileMode(value: number | undefined): number {
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o777) {
    return Number(value)
  }
  throw new FileChangeExecutionError(
    'RESOURCE_CHANGED',
    'Approved file mutation is missing the original file mode',
  )
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
