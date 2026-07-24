import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { FileChangeCommandResult } from '../../shared/domain-state-api'
import type {
  FileChangeListCursor,
  FileChangePage,
} from '../../shared/file-change'
import type { FileChangeId, SessionId } from '../../shared/ids'
import type { ConfigStore } from '../config/store'
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
  sha256,
} from './file-change-filesystem'

const FILE_CHANGE_TOOL_OPERATIONS = {
  create_file: 'write',
  apply_patch: 'patch',
  delete_file: 'delete',
} as const

export interface FileChangeServiceOptions {
  coordinator: ApplicationStateCoordinator
  configStore: ConfigStore
  fileChanges?: FileChangeRepository
  sessions?: SessionRepository
  projects?: ProjectRepository
  now?: () => string
  createId?: () => FileChangeId
  onDiagnostic?: (message: string, error?: unknown) => void
}

export class FileChangeService implements FileChangeExecutionPort {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #configStore: ConfigStore
  readonly #fileChanges: FileChangeRepository
  readonly #sessions: SessionRepository
  readonly #projects: ProjectRepository
  readonly #now: () => string
  readonly #createId: () => FileChangeId
  readonly #onDiagnostic: (message: string, error?: unknown) => void

  constructor(options: FileChangeServiceOptions) {
    this.#coordinator = options.coordinator
    this.#configStore = options.configStore
    this.#fileChanges = options.fileChanges ?? new FileChangeRepository()
    this.#sessions = options.sessions ?? new SessionRepository()
    this.#projects = options.projects ?? new ProjectRepository()
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId =
      options.createId ?? (() => `file-change:${randomUUID()}` as FileChangeId)
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

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
    const maximumPayloadBytes =
      this.#configStore.getPublicConfig().limits.fileChangeHistoryBytes
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
      callId: input.approvedCall.callId,
      path: precondition.path,
      operation,
      diff: input.diff,
      diffHash,
      diffTruncated: isFileDiffTruncated(input.diff),
      beforeExists: precondition.expectedExists,
      beforeHash,
      beforeContent,
      afterExists: operation !== 'delete',
      afterHash,
      payloadBytes,
      maximumPayloadBytes,
    }
  }

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
      ...input.prepared,
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

  // Implemented with writer/lifecycle ownership in the P5 revert group.
  revert(
    _sessionId: SessionId,
    _fileChangeId: FileChangeId,
    _expectedRevision: number,
  ): Promise<FileChangeCommandResult> {
    return Promise.reject(
      new ApplicationError(
        'PRECONDITION_FAILED',
        'File change revert is not initialized',
      ),
    )
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

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
