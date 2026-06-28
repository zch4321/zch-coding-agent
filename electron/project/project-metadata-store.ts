import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  ProjectModelFileSchema,
  ProjectModelSchema,
  type CodeBackendBinding,
  type ProjectMetadataSnapshot,
  type ProjectModel,
  type ProjectModelFile,
  type SerenaBackendConfig,
  type SerenaLanguageBackend,
  type SerenaLogLevel,
  type SerenaProjectMode,
} from '../../shared/project-model'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import { writeJsonAtomic } from '../config/atomic-file'
import { ProjectModuleDetector } from './module-detector'

const PROJECT_DIRECTORY = '.zch'
const PROJECT_MODEL_FILE = 'project-model.json'
const DEFAULT_SERENA_ID = 'serena'
const READONLY_CAPABILITIES = [
  'symbol_overview',
  'definition',
  'references',
  'workspace_symbols',
  'diagnostics',
] as const
const DEFAULT_SERENA_CONTEXT = 'ide-assistant'
const DEFAULT_SERENA_PROJECT_MODE: SerenaProjectMode = 'workspacePath'
const DEFAULT_SERENA_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
]
const LEGACY_DEFAULT_SERENA_ARGS = [
  'start-mcp-server',
  '--context',
  DEFAULT_SERENA_CONTEXT,
  '--project',
  '${workspace}',
]
const SERENA_LANGUAGE_BACKENDS = new Set<SerenaLanguageBackend>([
  'LSP',
  'JetBrains',
])
const SERENA_LOG_LEVELS = new Set<SerenaLogLevel>([
  'DEBUG',
  'INFO',
  'WARNING',
  'ERROR',
  'CRITICAL',
])

const validateProjectModel = compileSchema(ProjectModelSchema)
const validateProjectModelFile = compileSchema(ProjectModelFileSchema)

export class ProjectMetadataError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PROJECT_MODEL'
      | 'PATH_OUTSIDE_WORKSPACE'
      | 'WORKSPACE_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'ProjectMetadataError'
  }
}

function toPortable(relativePath: string): string {
  return relativePath.split(path.sep).join('/') || '.'
}

function defaultModel(workspaceRoot: string): ProjectModel {
  const now = new Date().toISOString()
  const project: ProjectModel = {
    schemaVersion: 1,
    workspaceRoot,
    modules: [],
    storage: 'project-local',
    backendBindings: [],
    serena: {
      id: DEFAULT_SERENA_ID,
      enabled: false,
      command: 'serena',
      context: DEFAULT_SERENA_CONTEXT,
      projectMode: DEFAULT_SERENA_PROJECT_MODE,
      openWebDashboard: false,
      extraArgs: [],
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 30_000,
      languages: DEFAULT_SERENA_LANGUAGES,
    },
    updatedAt: now,
  }
  project.backendBindings = defaultBindings(project)
  return project
}

function defaultBindings(project: ProjectModel): CodeBackendBinding[] {
  const now = new Date().toISOString()
  const languages = new Set(project.serena.languages)

  for (const module of project.modules) {
    for (const language of module.languages) {
      languages.add(language)
    }
  }

  return [...languages].sort().map((language) => ({
    id: `${project.serena.id}:${language}`,
    language,
    backendId: project.serena.id,
    backendKind: 'serena-mcp',
    enabled: project.serena.enabled,
    capabilities: [...READONLY_CAPABILITIES],
    configuredBy: 'user',
    updatedAt: now,
  }))
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return undefined
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((arg, index) => arg === right[index])
  )
}

function migrateLegacyArgs(
  args: readonly string[] | undefined,
  workspaceRoot: string,
): Partial<SerenaBackendConfig> {
  if (
    !args ||
    args.length === 0 ||
    sameArgs(args, LEGACY_DEFAULT_SERENA_ARGS)
  ) {
    return {}
  }

  const migrated: Partial<SerenaBackendConfig> = {}
  const extraArgs: string[] = []
  let index = args[0] === 'start-mcp-server' ? 1 : 0

  while (index < args.length) {
    const arg = args[index]
    const next = args[index + 1]

    switch (arg) {
      case '--context':
        if (next) {
          migrated.context = next
          index += 2
        } else {
          extraArgs.push(arg)
          index += 1
        }
        break
      case '--project':
      case '--project-file':
        if (next === '${workspace}' || next === workspaceRoot) {
          migrated.projectMode = 'workspacePath'
        } else if (next) {
          migrated.projectMode = 'none'
          extraArgs.push(arg, next)
        } else {
          extraArgs.push(arg)
        }
        index += next ? 2 : 1
        break
      case '--project-from-cwd':
        migrated.projectMode = 'projectFromCwd'
        index += 1
        break
      case '--language-backend':
        if (
          next &&
          SERENA_LANGUAGE_BACKENDS.has(next as SerenaLanguageBackend)
        ) {
          migrated.languageBackend = next as SerenaLanguageBackend
        } else {
          extraArgs.push(...(next ? [arg, next] : [arg]))
        }
        index += next ? 2 : 1
        break
      case '--enable-web-dashboard': {
        const parsed = parseBoolean(next)
        if (parsed === undefined)
          extraArgs.push(...(next ? [arg, next] : [arg]))
        else migrated.enableWebDashboard = parsed
        index += next ? 2 : 1
        break
      }
      case '--open-web-dashboard': {
        const parsed = parseBoolean(next)
        if (parsed === undefined)
          extraArgs.push(...(next ? [arg, next] : [arg]))
        else migrated.openWebDashboard = parsed
        index += next ? 2 : 1
        break
      }
      case '--log-level':
        if (next && SERENA_LOG_LEVELS.has(next as SerenaLogLevel)) {
          migrated.logLevel = next as SerenaLogLevel
        } else {
          extraArgs.push(...(next ? [arg, next] : [arg]))
        }
        index += next ? 2 : 1
        break
      case '--tool-timeout': {
        const seconds = next ? Number(next) : Number.NaN
        if (Number.isFinite(seconds) && seconds > 0) {
          migrated.toolTimeoutMs = Math.round(seconds * 1_000)
        } else {
          extraArgs.push(...(next ? [arg, next] : [arg]))
        }
        index += next ? 2 : 1
        break
      }
      default:
        extraArgs.push(arg)
        index += 1
        break
    }
  }

  if (extraArgs.length > 0) migrated.extraArgs = extraArgs
  return migrated
}

function normalizeSerena(
  input: SerenaBackendConfig,
  workspaceRoot: string,
): SerenaBackendConfig {
  const migrated = migrateLegacyArgs(input.args, workspaceRoot)
  const normalized: SerenaBackendConfig = {
    id: input.id || DEFAULT_SERENA_ID,
    enabled: input.enabled,
    command: input.command || 'serena',
    context: input.context || migrated.context || DEFAULT_SERENA_CONTEXT,
    projectMode:
      input.projectMode || migrated.projectMode || DEFAULT_SERENA_PROJECT_MODE,
    openWebDashboard:
      input.openWebDashboard ?? migrated.openWebDashboard ?? false,
    extraArgs: input.extraArgs ?? migrated.extraArgs ?? [],
    startupTimeoutMs: input.startupTimeoutMs || 15_000,
    toolTimeoutMs: migrated.toolTimeoutMs || input.toolTimeoutMs || 30_000,
    languages:
      input.languages.length > 0
        ? [...new Set(input.languages)].sort()
        : DEFAULT_SERENA_LANGUAGES,
  }
  const enableWebDashboard =
    input.enableWebDashboard ?? migrated.enableWebDashboard

  if (input.cwd) normalized.cwd = input.cwd
  if (input.languageBackend || migrated.languageBackend) {
    normalized.languageBackend =
      input.languageBackend ?? migrated.languageBackend
  }
  if (enableWebDashboard !== undefined) {
    normalized.enableWebDashboard = enableWebDashboard
  }
  if (input.logLevel || migrated.logLevel) {
    normalized.logLevel = input.logLevel ?? migrated.logLevel
  }

  return normalized
}

function normalizeBindings(
  project: ProjectModel,
  updatedAt: string,
): CodeBackendBinding[] {
  if (project.backendBindings.length === 0) {
    return defaultBindings(project)
  }

  return project.backendBindings.map((binding) => {
    if (
      binding.backendKind !== 'serena-mcp' ||
      binding.backendId !== project.serena.id
    ) {
      return binding
    }

    return {
      ...binding,
      capabilities: [
        ...new Set([...binding.capabilities, ...READONLY_CAPABILITIES]),
      ],
      updatedAt: binding.updatedAt || updatedAt,
    }
  })
}

function normalizeProject(project: ProjectModel, workspaceRoot: string) {
  const now = new Date().toISOString()
  const next: ProjectModel = {
    ...structuredClone(project),
    schemaVersion: 1,
    workspaceRoot,
    storage: 'project-local',
    updatedAt: project.updatedAt || now,
    serena: normalizeSerena(project.serena, workspaceRoot),
  }

  if (!next.defaultModuleId && next.modules[0]) {
    next.defaultModuleId = next.modules[0].id
  }

  next.backendBindings = normalizeBindings(next, now)

  return next
}

function assertProjectModel(value: unknown): ProjectModel {
  if (!validateProjectModel(value)) {
    throw new ProjectMetadataError(
      'INVALID_PROJECT_MODEL',
      formatSchemaErrors(validateProjectModel.errors),
    )
  }

  return structuredClone(value as ProjectModel)
}

function assertProjectModelFile(value: unknown): ProjectModelFile {
  if (!validateProjectModelFile(value)) {
    throw new ProjectMetadataError(
      'INVALID_PROJECT_MODEL',
      formatSchemaErrors(validateProjectModelFile.errors),
    )
  }

  return value as ProjectModelFile
}

async function gitIgnoreRecommended(workspaceRoot: string): Promise<boolean> {
  try {
    const content = await readFile(
      path.join(workspaceRoot, '.gitignore'),
      'utf8',
    )
    return !content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .some((line) => line === '.zch' || line === '.zch/')
  } catch {
    return true
  }
}

export class ProjectMetadataStore {
  readonly #detector: ProjectModuleDetector
  readonly #mutations = new Map<string, Promise<unknown>>()

  constructor(detector = new ProjectModuleDetector()) {
    this.#detector = detector
  }

  async get(workspace: string): Promise<ProjectMetadataSnapshot> {
    const guard = await this.#guard(workspace)
    const filePath = this.#filePath(guard)
    let project: ProjectModel

    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      project = normalizeProject(
        assertProjectModelFile(parsed).project,
        guard.workspacePath,
      )
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        project = await this.#createDefault(guard)
      } else {
        throw error
      }
    }

    return this.#snapshot(guard, project)
  }

  async save(
    workspace: string,
    project: ProjectModel,
  ): Promise<ProjectMetadataSnapshot> {
    const guard = await this.#guard(workspace)
    const key = guard.workspacePath
    const operation = (this.#mutations.get(key) ?? Promise.resolve()).then(
      async () => {
        const normalized = this.#validatePaths(
          guard,
          normalizeProject(assertProjectModel(project), guard.workspacePath),
        )
        normalized.updatedAt = new Date().toISOString()
        await this.#write(guard, normalized)
        return this.#snapshot(guard, normalized)
      },
    )
    this.#mutations.set(
      key,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    )
    return operation
  }

  async detectModules(workspace: string) {
    const guard = await this.#guard(workspace)
    return this.#detector.detect(guard.workspacePath)
  }

  async #guard(workspace: string): Promise<PathGuard> {
    try {
      return await PathGuard.create(workspace)
    } catch (error) {
      if (error instanceof PathGuardError) {
        throw new ProjectMetadataError(
          error.code === 'PATH_OUTSIDE_WORKSPACE'
            ? 'PATH_OUTSIDE_WORKSPACE'
            : 'WORKSPACE_NOT_FOUND',
          error.message,
        )
      }

      throw error
    }
  }

  #filePath(guard: PathGuard): string {
    return guard.resolveCandidate(
      path.join(PROJECT_DIRECTORY, PROJECT_MODEL_FILE),
    )
  }

  async #createDefault(guard: PathGuard): Promise<ProjectModel> {
    const project = defaultModel(guard.workspacePath)
    await this.#write(guard, project)
    return project
  }

  async #write(guard: PathGuard, project: ProjectModel): Promise<void> {
    const directory = guard.resolveCandidate(PROJECT_DIRECTORY)
    const parent = path.dirname(directory)
    guard.assertInside(parent)
    await mkdir(directory, { recursive: true })
    const directoryStat = await stat(directory)

    if (!directoryStat.isDirectory()) {
      throw new ProjectMetadataError(
        'INVALID_PROJECT_MODEL',
        '.zch must be a directory',
      )
    }

    await writeJsonAtomic(this.#filePath(guard), {
      schemaVersion: 1,
      project,
    } satisfies ProjectModelFile)
  }

  #validatePaths(guard: PathGuard, project: ProjectModel): ProjectModel {
    for (const module of project.modules) {
      guard.resolveCandidate(module.root)
      for (const collection of [
        module.manifests,
        module.sourceRoots,
        module.testRoots,
        module.excludedRoots,
      ]) {
        for (const relativePath of collection) {
          guard.resolveCandidate(relativePath)
        }
      }
    }

    if (
      project.defaultModuleId &&
      !project.modules.some((module) => module.id === project.defaultModuleId)
    ) {
      delete project.defaultModuleId
    }

    project.modules = project.modules.map((module) => ({
      ...module,
      root: toPortable(module.root),
      manifests: module.manifests.map(toPortable),
      sourceRoots: module.sourceRoots.map(toPortable),
      testRoots: module.testRoots.map(toPortable),
      excludedRoots: module.excludedRoots.map(toPortable),
    }))

    return project
  }

  async #snapshot(
    guard: PathGuard,
    project: ProjectModel,
  ): Promise<ProjectMetadataSnapshot> {
    return {
      project,
      path: toPortable(path.join(PROJECT_DIRECTORY, PROJECT_MODEL_FILE)),
      gitIgnoreRecommended: await gitIgnoreRecommended(guard.workspacePath),
    }
  }
}
