import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { writeJsonAtomic } from '../config/atomic-file'
import {
  WorkbenchFileSchema,
  PersistedWorkbenchSchema,
  type ConversationRecord,
  type PersistedWorkbench,
  type ProjectRecord,
  type WorkbenchFile,
} from '../../shared/workbench'

const validateWorkbench = compileSchema(PersistedWorkbenchSchema)
const validateWorkbenchFile = compileSchema(WorkbenchFileSchema)

function emptyWorkbench(): PersistedWorkbench {
  return { projects: [], conversations: [] }
}

function projectName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? workspacePath
}

function normalizeWorkbench(candidate: PersistedWorkbench): PersistedWorkbench {
  const projects = new Map<string, ProjectRecord>()
  const conversations = new Map<string, ConversationRecord>()

  for (const project of candidate.projects) {
    projects.set(project.path, {
      ...project,
      name: project.name.trim() || projectName(project.path),
    })
  }

  for (const conversation of candidate.conversations) {
    conversations.set(conversation.id, {
      ...conversation,
      tools: conversation.tools ?? [],
    })

    if (!projects.has(conversation.projectPath)) {
      projects.set(conversation.projectPath, {
        path: conversation.projectPath,
        name: projectName(conversation.projectPath),
        addedAt: conversation.createdAt,
      })
    }
  }

  const activeConversationId =
    candidate.activeConversationId &&
    conversations.has(candidate.activeConversationId)
      ? candidate.activeConversationId
      : undefined

  return {
    projects: [...projects.values()].sort((left, right) =>
      left.addedAt.localeCompare(right.addedAt),
    ),
    conversations: [...conversations.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    ...(activeConversationId ? { activeConversationId } : {}),
  }
}

function assertWorkbench(value: unknown): PersistedWorkbench {
  if (!validateWorkbench(value)) {
    throw new Error(formatSchemaErrors(validateWorkbench.errors))
  }

  return normalizeWorkbench(value as PersistedWorkbench)
}

function assertWorkbenchFile(value: unknown): WorkbenchFile {
  if (!validateWorkbenchFile(value)) {
    throw new Error(formatSchemaErrors(validateWorkbenchFile.errors))
  }

  return {
    schemaVersion: 1,
    workbench: normalizeWorkbench((value as WorkbenchFile).workbench),
  }
}

export class WorkbenchStore {
  readonly #filePath: string
  #state: PersistedWorkbench = emptyWorkbench()
  #mutation = Promise.resolve()

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async initialize(): Promise<PersistedWorkbench> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
    this.#state = await this.#read()
    return this.get()
  }

  get(): PersistedWorkbench {
    return structuredClone(this.#state)
  }

  getSnapshot(): PersistedWorkbench {
    return this.get()
  }

  save(snapshot: PersistedWorkbench): Promise<PersistedWorkbench> {
    return this.saveSnapshot(snapshot)
  }

  saveSnapshot(snapshot: PersistedWorkbench): Promise<PersistedWorkbench> {
    const operation = this.#mutation.then(async () => {
      const next = assertWorkbench(snapshot)
      await writeJsonAtomic(this.#filePath, {
        schemaVersion: 1,
        workbench: next,
      } satisfies WorkbenchFile)
      this.#state = next
      return this.get()
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  importLegacy(snapshot: PersistedWorkbench): Promise<PersistedWorkbench> {
    return this.mergeSnapshot(snapshot)
  }

  mergeSnapshot(snapshot: PersistedWorkbench): Promise<PersistedWorkbench> {
    const operation = this.#mutation.then(async () => {
      const legacy = assertWorkbench(snapshot)
      const merged = normalizeWorkbench({
        projects: [...this.#state.projects, ...legacy.projects],
        conversations: [
          ...this.#state.conversations,
          ...legacy.conversations.filter(
            (legacyConversation) =>
              !this.#state.conversations.some(
                (current) => current.id === legacyConversation.id,
              ),
          ),
        ],
        activeConversationId:
          this.#state.activeConversationId ?? legacy.activeConversationId,
      })

      await writeJsonAtomic(this.#filePath, {
        schemaVersion: 1,
        workbench: merged,
      } satisfies WorkbenchFile)
      this.#state = merged
      return this.get()
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async #read(): Promise<PersistedWorkbench> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8'))
      if (
        parsed &&
        typeof parsed === 'object' &&
        Reflect.get(parsed, 'schemaVersion') === 1
      ) {
        return assertWorkbenchFile(parsed).workbench
      }

      return assertWorkbench(parsed)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        const initial = emptyWorkbench()
        await writeJsonAtomic(this.#filePath, {
          schemaVersion: 1,
          workbench: initial,
        } satisfies WorkbenchFile)
        return initial
      }

      throw error
    }
  }
}
