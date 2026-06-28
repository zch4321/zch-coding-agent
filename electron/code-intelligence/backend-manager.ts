import { stat } from 'node:fs/promises'
import type {
  CodeBackendStatus,
  CodeIntelligenceCapability,
  CodeIntelligenceResult,
  CodeIntelligenceResultCode,
  ProjectModel,
  ProjectModule,
} from '../../shared/project-model'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import { PathGuard } from '../safety/path-guard'
import { SerenaMcpAdapter } from './serena-mcp-adapter'
import type { CodeIntelligenceQuery } from './types'

function unsupported(input: {
  backendId: string
  capability: CodeIntelligenceCapability
  message: string
  code: CodeIntelligenceResultCode
}): CodeIntelligenceResult {
  return {
    backendId: input.backendId,
    capability: input.capability,
    precision: 'unsupported',
    source: 'code-intelligence-router',
    truncated: false,
    items: [],
    message: input.message,
    code: input.code,
  }
}

function isInsideModule(module: ProjectModule, relativePath: string): boolean {
  return (
    module.root === '.' ||
    relativePath === module.root ||
    relativePath.startsWith(`${module.root}/`)
  )
}

function requiresFilePath(capability: CodeIntelligenceCapability): boolean {
  return capability === 'symbol_overview' || capability === 'diagnostics'
}

function pickModule(
  project: ProjectModel,
  moduleId: string | undefined,
  relativePath: string | undefined,
): ProjectModule | undefined {
  if (moduleId) {
    return project.modules.find((module) => module.id === moduleId)
  }

  if (relativePath) {
    const matches = project.modules.filter((module) =>
      isInsideModule(module, relativePath),
    )
    return matches.sort(
      (left, right) => right.root.length - left.root.length,
    )[0]
  }

  return (
    project.modules.find((module) => module.id === project.defaultModuleId) ??
    project.modules[0]
  )
}

export class CodeBackendManager {
  readonly #projectMetadata: ProjectMetadataStore
  readonly #serena: SerenaMcpAdapter

  constructor(options: {
    projectMetadata: ProjectMetadataStore
    serena?: SerenaMcpAdapter
  }) {
    this.#projectMetadata = options.projectMetadata
    this.#serena = options.serena ?? new SerenaMcpAdapter()
  }

  async statuses(workspace: string): Promise<CodeBackendStatus[]> {
    const { project } = await this.#projectMetadata.get(workspace)
    return [this.#serena.status(project)]
  }

  async restart(
    workspace: string,
    backendId: string,
  ): Promise<CodeBackendStatus> {
    const { project } = await this.#projectMetadata.get(workspace)

    if (backendId !== project.serena.id) {
      return {
        backendId,
        backendKind: 'fallback',
        state: 'error',
        capabilities: [],
        message: `Unknown code backend: ${backendId}`,
        updatedAt: new Date().toISOString(),
      }
    }

    return this.#serena.restart(project)
  }

  async query(input: CodeIntelligenceQuery): Promise<CodeIntelligenceResult> {
    const snapshot = await this.#projectMetadata.get(input.workspace)
    const project = snapshot.project
    const guard = await PathGuard.create(input.workspace)
    let relativePath = input.path
    let absolutePath: string | undefined

    if (relativePath) {
      const resolved = await guard.resolveExisting(relativePath)
      relativePath = resolved.relativePath
      absolutePath = resolved.absolutePath
    }

    const module = pickModule(project, input.moduleId, relativePath)

    if (project.modules.length > 0 && !module) {
      return unsupported({
        backendId: project.serena.id,
        capability: input.capability,
        code: 'MODULE_NOT_FOUND',
        message: input.moduleId
          ? `Module not found: ${input.moduleId}`
          : 'No project module matches this path.',
      })
    }

    if (relativePath && module && !isInsideModule(module, relativePath)) {
      return unsupported({
        backendId: project.serena.id,
        capability: input.capability,
        code: 'PATH_OUTSIDE_MODULE',
        message: `Path ${relativePath} is outside module ${module.id}.`,
      })
    }

    if (requiresFilePath(input.capability)) {
      if (!relativePath || !absolutePath) {
        return unsupported({
          backendId: project.serena.id,
          capability: input.capability,
          code: 'PATH_NOT_FILE',
          message: `${input.capability} requires a workspace-relative file path.`,
        })
      }

      const pathStat = await stat(absolutePath)
      if (!pathStat.isFile()) {
        return unsupported({
          backendId: project.serena.id,
          capability: input.capability,
          code: 'PATH_NOT_FILE',
          message: `${relativePath} is not a file. Use code_workspace_symbols or narrow the query to a source file first.`,
        })
      }
    }

    const binding = project.backendBindings.find(
      (candidate) =>
        candidate.enabled &&
        candidate.backendId === project.serena.id &&
        (!module || !candidate.moduleId || candidate.moduleId === module.id) &&
        (!module ||
          module.languages.length === 0 ||
          module.languages.includes(candidate.language)),
    )

    if (!binding) {
      return unsupported({
        backendId: project.serena.id,
        capability: input.capability,
        code: 'BACKEND_UNAVAILABLE',
        message:
          'No enabled code intelligence backend is configured for this module or language.',
      })
    }

    if (!binding.capabilities.includes(input.capability)) {
      return unsupported({
        backendId: binding.backendId,
        capability: input.capability,
        code: 'UNSUPPORTED_CAPABILITY',
        message: `Backend ${binding.backendId} does not support ${input.capability}.`,
      })
    }

    return this.#serena.query(project, {
      ...input,
      path: relativePath ?? module?.root ?? '.',
      moduleId: module?.id ?? input.moduleId,
    })
  }

  dispose(): Promise<void> {
    return this.#serena.dispose()
  }
}
