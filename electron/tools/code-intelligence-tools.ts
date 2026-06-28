import { Type, type Static } from '@sinclair/typebox'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'

const BaseCodeQuerySchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative file or directory path. Omit only for workspace-wide symbol search.',
      }),
    ),
    moduleId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          'Optional ProjectModel module id when the path is ambiguous.',
      }),
    ),
  },
  { additionalProperties: false },
)

const SymbolOverviewSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative file or directory path to summarize semantically.',
    }),
    moduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
type SymbolOverviewArgs = Static<typeof SymbolOverviewSchema>

const SymbolAtPathSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative file path that contains or references the symbol.',
    }),
    symbolName: Type.String({
      minLength: 1,
      maxLength: 512,
      description:
        'Symbol name or name path. Prefer exact names from code_symbol_overview.',
    }),
    moduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
type SymbolAtPathArgs = Static<typeof SymbolAtPathSchema>

const WorkspaceSymbolsSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 512,
      description: 'Symbol name or substring to search in the workspace.',
    }),
    moduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
type WorkspaceSymbolsArgs = Static<typeof WorkspaceSymbolsSchema>

type DiagnosticsArgs = Static<typeof BaseCodeQuerySchema>

function toolError(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'CODE_INTELLIGENCE_FAILED',
    message:
      error instanceof Error ? error.message : 'Code intelligence query failed',
    retryable: false,
  }
}

export function registerCodeIntelligenceTools(
  registry: ToolRegistrationPort,
  codeBackends: CodeBackendManager,
): void {
  registry.registerTool({
    id: 'code_symbol_overview',
    description:
      'Use IDE-level code intelligence to summarize symbols in a file or directory before reading large source files.',
    inputSchema: SymbolOverviewSchema,
    effects: ['code.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: SymbolOverviewArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await codeBackends.query({
            capability: 'symbol_overview',
            workspace: context.workspace.canonicalPath,
            path: args.path,
            moduleId: args.moduleId,
          }),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof SymbolOverviewSchema>)

  registry.registerTool({
    id: 'code_find_definition',
    description:
      'Find a symbol definition through the configured IDE/code-intelligence backend.',
    inputSchema: SymbolAtPathSchema,
    effects: ['code.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: SymbolAtPathArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await codeBackends.query({
            capability: 'definition',
            workspace: context.workspace.canonicalPath,
            path: args.path,
            symbolName: args.symbolName,
            moduleId: args.moduleId,
          }),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof SymbolAtPathSchema>)

  registry.registerTool({
    id: 'code_find_references',
    description:
      'Find references for a symbol through the configured IDE/code-intelligence backend.',
    inputSchema: SymbolAtPathSchema,
    effects: ['code.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: SymbolAtPathArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await codeBackends.query({
            capability: 'references',
            workspace: context.workspace.canonicalPath,
            path: args.path,
            symbolName: args.symbolName,
            moduleId: args.moduleId,
          }),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof SymbolAtPathSchema>)

  registry.registerTool({
    id: 'code_workspace_symbols',
    description:
      'Search workspace symbols through the configured IDE/code-intelligence backend.',
    inputSchema: WorkspaceSymbolsSchema,
    effects: ['code.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: WorkspaceSymbolsArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await codeBackends.query({
            capability: 'workspace_symbols',
            workspace: context.workspace.canonicalPath,
            query: args.query,
            moduleId: args.moduleId,
          }),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof WorkspaceSymbolsSchema>)

  registry.registerTool({
    id: 'code_diagnostics',
    description:
      'Return project diagnostics from the configured IDE/code-intelligence backend when supported.',
    inputSchema: BaseCodeQuerySchema,
    effects: ['code.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: DiagnosticsArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await codeBackends.query({
            capability: 'diagnostics',
            workspace: context.workspace.canonicalPath,
            path: args.path,
            moduleId: args.moduleId,
          }),
        }
      } catch (error) {
        return toolError(error)
      }
    },
  } satisfies ToolDefinition<typeof BaseCodeQuerySchema>)
}
