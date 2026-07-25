import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProjectCommandResult,
  ProjectUpdatePayloadSchema,
} from '../../shared/domain-state-api'
import type { ProjectId } from '../../shared/ids'
import type { ProjectRecord } from '../../shared/project'
import { MAX_PROJECT_RECORDS } from '../../shared/durable'
import type { Static } from '@sinclair/typebox'
import { ProjectRepository } from '../persistence/project-repository'
import {
  ApplicationError,
  normalizeApplicationError,
} from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'

export interface ProjectRuntimeGuard {
  assertProjectIdle(projectId: ProjectId): void
  reserveProjectEviction?(projectId: ProjectId): string
  cancelProjectEviction?(projectId: ProjectId, token: string): void
  evictIdleProject?(
    projectId: ProjectId,
    operationToken?: string,
  ): void | Promise<void>
}

export interface ProjectServiceOptions {
  coordinator: ApplicationStateCoordinator
  repository?: ProjectRepository
  runtimeGuard?: ProjectRuntimeGuard
  now?: () => string
  createId?: () => ProjectId
  onDiagnostic?: (message: string, error?: unknown) => void
}

type ProjectUpdatePatch = Static<typeof ProjectUpdatePayloadSchema>['patch']

export class ProjectService {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #repository: ProjectRepository
  readonly #runtimeGuard?: ProjectRuntimeGuard
  readonly #now: () => string
  readonly #createId: () => ProjectId
  readonly #onDiagnostic: (message: string, error?: unknown) => void

  constructor(options: ProjectServiceOptions) {
    this.#coordinator = options.coordinator
    this.#repository = options.repository ?? new ProjectRepository()
    this.#runtimeGuard = options.runtimeGuard
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId =
      options.createId ?? (() => `project:${randomUUID()}` as ProjectId)
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  async list(): Promise<ProjectRecord[]> {
    return (
      await this.#coordinator.query((reader) => this.#repository.list(reader))
    ).value
  }

  async get(projectId: ProjectId): Promise<ProjectRecord> {
    const record = (
      await this.#coordinator.query((reader) =>
        this.#repository.get(reader, projectId),
      )
    ).value
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Project was not found')
    }
    return record
  }

  async add(input: {
    path: string
    name?: string
  }): Promise<ProjectCommandResult> {
    const canonicalPath = await canonicalWorkspacePath(input.path)
    const timestamp = this.#now()
    const record: ProjectRecord = {
      schemaVersion: 1,
      id: this.#createId(),
      path: canonicalPath,
      name: input.name?.trim() || path.basename(canonicalPath),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      return await this.#coordinator.command(
        'project.changed',
        (transaction) => {
          if (this.#repository.count(transaction) >= MAX_PROJECT_RECORDS) {
            throw new ApplicationError(
              'PRECONDITION_FAILED',
              `Project limit of ${MAX_PROJECT_RECORDS} has been reached`,
            )
          }
          this.#repository.insert(transaction, record)
          return { projects: this.#repository.list(transaction) }
        },
      )
    } catch (error) {
      throw normalizeApplicationError(error)
    }
  }

  async update(input: {
    projectId: ProjectId
    expectedRevision: number
    patch: ProjectUpdatePatch
  }): Promise<ProjectCommandResult> {
    const canonicalPath =
      input.patch.path === undefined
        ? undefined
        : await canonicalWorkspacePath(input.patch.path)
    const operationToken =
      canonicalPath === undefined
        ? undefined
        : this.#runtimeGuard?.reserveProjectEviction?.(input.projectId)
    let result: ProjectCommandResult
    try {
      result = await this.#coordinator.command(
        'project.changed',
        (transaction) => {
          if (canonicalPath !== undefined && !operationToken) {
            this.#runtimeGuard?.assertProjectIdle(input.projectId)
          }
          const current = this.#repository.get(transaction, input.projectId)
          if (!current) {
            throw new ApplicationError('NOT_FOUND', 'Project was not found')
          }
          if (current.revision !== input.expectedRevision) {
            throw revisionConflict('Project', current.revision)
          }
          const next: ProjectRecord = {
            ...current,
            ...(canonicalPath === undefined ? {} : { path: canonicalPath }),
            ...(input.patch.name === undefined
              ? {}
              : { name: input.patch.name.trim() }),
            revision: current.revision + 1,
            updatedAt: this.#now(),
          }
          if (!this.#repository.update(transaction, next, current.revision)) {
            throw revisionConflict('Project', current.revision)
          }
          return { projects: this.#repository.list(transaction) }
        },
      )
    } catch (error) {
      if (operationToken) {
        this.#runtimeGuard?.cancelProjectEviction?.(
          input.projectId,
          operationToken,
        )
      }
      throw error
    }
    if (canonicalPath !== undefined) {
      try {
        await this.#runtimeGuard?.evictIdleProject?.(
          input.projectId,
          operationToken,
        )
      } catch (error) {
        this.#onDiagnostic(
          `Updated Project ${input.projectId} could not evict its runtime contexts`,
          error,
        )
      }
    }
    return result
  }

  async remove(input: {
    projectId: ProjectId
    expectedRevision: number
  }): Promise<ProjectCommandResult> {
    const operationToken = this.#runtimeGuard?.reserveProjectEviction?.(
      input.projectId,
    )
    let result: ProjectCommandResult
    try {
      result = await this.#coordinator.command(
        'project.changed',
        (transaction) => {
          if (!operationToken) {
            this.#runtimeGuard?.assertProjectIdle(input.projectId)
          }
          const current = this.#repository.get(transaction, input.projectId)
          if (!current) {
            throw new ApplicationError('NOT_FOUND', 'Project was not found')
          }
          if (current.revision !== input.expectedRevision) {
            throw revisionConflict('Project', current.revision)
          }
          if (!this.#repository.delete(transaction, input.projectId)) {
            throw revisionConflict('Project', current.revision)
          }
          return { projects: this.#repository.list(transaction) }
        },
      )
    } catch (error) {
      if (operationToken) {
        this.#runtimeGuard?.cancelProjectEviction?.(
          input.projectId,
          operationToken,
        )
      }
      throw error
    }
    try {
      await this.#runtimeGuard?.evictIdleProject?.(
        input.projectId,
        operationToken,
      )
    } catch (error) {
      this.#onDiagnostic(
        `Removed Project ${input.projectId} could not evict its runtime contexts`,
        error,
      )
    }
    return result
  }
}

async function canonicalWorkspacePath(input: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(input))
    const stats = await stat(canonical)
    if (!stats.isDirectory()) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Project workspace must be a directory',
      )
    }
    return canonical
  } catch (error) {
    if (error instanceof ApplicationError) throw error
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Project workspace cannot be resolved',
      { cause: error },
    )
  }
}

function revisionConflict(label: string, currentRevision: number) {
  return new ApplicationError('CONFLICT', `${label} revision has changed`, {
    details: { currentRevision },
  })
}
