import { createHash } from 'node:crypto'
import { Type, type Static } from '@sinclair/typebox'
import type { ProjectModule } from '../../shared/project-model'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'

const ModuleInputSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    root: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative module root, for example "." or "frontend".',
    }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    languages: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 32,
      }),
    ),
    manifests: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
        maxItems: 64,
      }),
    ),
    sourceRoots: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
        maxItems: 64,
      }),
    ),
    testRoots: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
        maxItems: 64,
      }),
    ),
    excludedRoots: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
        maxItems: 128,
      }),
    ),
    backendHints: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
      }),
    ),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
)
type ModuleInput = Static<typeof ModuleInputSchema>

const EmptySchema = Type.Object({}, { additionalProperties: false })

const SetModulesSchema = Type.Object(
  {
    modules: Type.Array(ModuleInputSchema, {
      minItems: 0,
      maxItems: 64,
      description:
        'Complete replacement module list. This updates only .zch project metadata.',
    }),
    defaultModuleId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
  },
  { additionalProperties: false },
)
type SetModulesArgs = Static<typeof SetModulesSchema>

const UpdateModuleSchema = Type.Object(
  {
    module: ModuleInputSchema,
    defaultModule: Type.Optional(
      Type.Boolean({
        description: 'Set true to make this module the default module.',
      }),
    ),
  },
  { additionalProperties: false },
)
type UpdateModuleArgs = Static<typeof UpdateModuleSchema>

function idFromRoot(root: string): string {
  const normalized =
    root === '.' ? 'root' : root.replace(/[^a-zA-Z0-9]+/gu, '-')
  return normalized.replace(/^-|-$/gu, '').toLowerCase() || 'root'
}

function nameFromRoot(root: string): string {
  return root === '.' ? 'workspace' : (root.split(/[\\/]/u).at(-1) ?? root)
}

function fingerprint(input: ModuleInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16)
}

function moduleFromInput(input: ModuleInput): ProjectModule {
  const updatedAt = new Date().toISOString()
  return {
    id: input.id ?? idFromRoot(input.root),
    root: input.root,
    name: input.name ?? nameFromRoot(input.root),
    languages: [...new Set(input.languages ?? [])].sort(),
    manifests: input.manifests ?? [],
    sourceRoots: input.sourceRoots ?? [],
    testRoots: input.testRoots ?? [],
    excludedRoots: input.excludedRoots ?? [],
    backendHints: input.backendHints ?? ['serena'],
    source: 'agent-set',
    confidence: input.confidence ?? 0.8,
    fingerprint: fingerprint(input),
    updatedAt,
  }
}

function toolError(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'PROJECT_METADATA_FAILED',
    message:
      error instanceof Error ? error.message : 'Project metadata update failed',
    retryable: false,
  }
}

export function registerProjectTools(
  registry: ToolRegistrationPort,
  projectMetadata: ProjectMetadataStore,
): void {
  registry.registerTool({
    id: 'project_get_modules',
    description:
      'Read the current .zch ProjectModel modules and code backend configuration for this workspace.',
    inputSchema: EmptySchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: false,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    async execute(_args, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await projectMetadata.get(context.workspace.canonicalPath),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof EmptySchema>)

  registry.registerTool({
    id: 'project_detect_modules',
    description:
      'Detect likely project modules from workspace manifests. This is read-only and does not update .zch metadata.',
    inputSchema: EmptySchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: false,
    defaultTimeoutMs: 15_000,
    maxOutputBytes: 64 * 1_024,
    async execute(_args, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: {
            modules: await projectMetadata.detectModules(
              context.workspace.canonicalPath,
            ),
          },
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof EmptySchema>)

  registry.registerTool({
    id: 'project_set_modules',
    description:
      'Replace the workspace module list in .zch project metadata. This does not modify source files or git history.',
    inputSchema: SetModulesSchema,
    effects: ['workspace.metadata.write'],
    defaultRisk: 'low',
    supportsAbort: false,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: SetModulesArgs, context): Promise<ToolResult> {
      try {
        const snapshot = await projectMetadata.get(
          context.workspace.canonicalPath,
        )
        const modules = args.modules.map(moduleFromInput)
        const project = {
          ...snapshot.project,
          modules,
          defaultModuleId: args.defaultModuleId ?? modules[0]?.id,
        }
        return {
          status: 'ok',
          content: await projectMetadata.save(
            context.workspace.canonicalPath,
            project,
          ),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof SetModulesSchema>)

  registry.registerTool({
    id: 'project_update_module',
    description:
      'Create or replace one module in .zch project metadata. Use this when the current module boundary is incomplete or wrong.',
    inputSchema: UpdateModuleSchema,
    effects: ['workspace.metadata.write'],
    defaultRisk: 'low',
    supportsAbort: false,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: UpdateModuleArgs, context): Promise<ToolResult> {
      try {
        const snapshot = await projectMetadata.get(
          context.workspace.canonicalPath,
        )
        const nextModule = moduleFromInput(args.module)
        const modules = [
          ...snapshot.project.modules.filter(
            (module) => module.id !== nextModule.id,
          ),
          nextModule,
        ]
        const project = {
          ...snapshot.project,
          modules,
          defaultModuleId: args.defaultModule
            ? nextModule.id
            : (snapshot.project.defaultModuleId ?? nextModule.id),
        }
        return {
          status: 'ok',
          content: await projectMetadata.save(
            context.workspace.canonicalPath,
            project,
          ),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof UpdateModuleSchema>)
}
