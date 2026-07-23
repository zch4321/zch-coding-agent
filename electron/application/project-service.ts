import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProjectCommandResult,
  ProjectUpdatePayloadSchema,
} from '../../shared/domain-state-api'
import type { ProjectId } from '../../shared/ids'
import type { ProjectRecord } from '../../shared/project'
import type { Static } from '@sinclair/typebox'
import { ProjectRepository } from '../persistence/project-repository'
import {
  ApplicationError,
  normalizeApplicationError,
} from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'

export interface ProjectRuntimeGuard {
  assertProjectIdle(projectId: ProjectId): void
  evictIdleProject?(projectId: ProjectId): void | Promise<void>
}

export interface ProjectServiceOptions {
  coordinator: ApplicationStateCoordinator
  repository?: ProjectRepository
  runtimeGuard?: ProjectRuntimeGuard
  now?: () => string
  createId?: () => ProjectId
}

type ProjectUpdatePatch = Static<typeof ProjectUpdatePayloadSchema>['patch']

export class ProjectService {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #repository: ProjectRepository
  readonly #runtimeGuard?: ProjectRuntimeGuard
  readonly #now: () => string
  readonly #createId: () => ProjectId

  constructor(options: ProjectServiceOptions) {
    this.#coordinator = options.coordinator
    this.#repository = options.repository ?? new ProjectRepository()
    this.#runtimeGuard = options.runtimeGuard
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId =
      options.createId ?? (() => `project:${randomUUID()}` as ProjectId)
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
    const result = await this.#coordinator.command(
      'project.changed',
      (transaction) => {
        this.#runtimeGuard?.assertProjectIdle(input.projectId)
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
    if (canonicalPath !== undefined) {
      await this.#runtimeGuard?.evictIdleProject?.(input.projectId)
    }
    return result
  }

  async remove(input: {
    projectId: ProjectId
    expectedRevision: number
  }): Promise<ProjectCommandResult> {
    const result = await this.#coordinator.command(
      'project.changed',
      (transaction) => {
        this.#runtimeGuard?.assertProjectIdle(input.projectId)
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
    await this.#runtimeGuard?.evictIdleProject?.(input.projectId)
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
