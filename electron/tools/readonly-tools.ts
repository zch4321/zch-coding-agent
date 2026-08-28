import { Type } from '@sinclair/typebox'
import path from 'node:path'
import type { JsonValue } from '../../shared/json'
import type { PublicConfig } from '../../shared/config'
import type { ToolDefinition, ToolResult } from './types'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import type { ToolRegistry } from './tool-registry'
import { DEFAULT_MAX_ENTRIES, walkFiles } from './workspace-walk'
import { type Searcher, resolveWorkspaceSearcher } from './searcher'
import { iterateWorkspaceGlobFiles } from './workspace-glob'
import {
  projectGlobResult,
  projectGrepResult,
  projectListDirResult,
  projectReadFileResult,
} from './tool-result-formatters'
import { readStreamingFile } from './streaming-file-reader'

const MAX_READ_LINES = 10_000
const READ_FILE_METADATA_RESERVE_BYTES = 256
const DEFAULT_LIMITS: Pick<
  PublicConfig['limits'],
  'maxToolOutputBytes' | 'maxToolOutputLines' | 'readFileSourceBytes'
> = {
  maxToolOutputBytes: 256 * 1_024,
  maxToolOutputLines: 500,
  readFileSourceBytes: 10_000_000,
}

const ReadFileArgsSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative path or absolute path inside the current Session temp directory.',
    }),
    startLine: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000_000,
        description: '1-based first line to read. Omit to start at line 1.',
      }),
    ),
    startCharacter: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 1_000_000_000,
        description:
          '0-based Unicode character offset within startLine. Use nextStartCharacter only when a previous page stopped inside one very long line.',
      }),
    ),
    lineCount: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_READ_LINES,
        description: `Maximum number of lines to return, up to ${MAX_READ_LINES}.`,
      }),
    ),
    lineNumbers: Type.Optional(
      Type.Boolean({
        description:
          'Whether to prefix returned lines with line numbers. Defaults to true.',
      }),
    ),
    tail: Type.Optional(
      Type.Boolean({
        description:
          'Read the final lineCount lines. Cannot be combined with startLine or startCharacter.',
      }),
    ),
  },
  { additionalProperties: false },
)

const ListDirArgsSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative directory or absolute Session-temp directory. Omit to list the workspace root.',
      }),
    ),
    recursive: Type.Optional(
      Type.Boolean({
        description:
          'Set true to recursively list files. Omit or false for one directory level.',
      }),
    ),
    maxEntries: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000,
        description: 'Maximum number of entries to return.',
      }),
    ),
  },
  { additionalProperties: false },
)

const GlobArgsSchema = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description:
        'Bash-style glob relative to path, for example **/*.{ts,tsx}. Use forward slashes.',
    }),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative directory or absolute Session-temp directory to search. Omit to search the workspace root.',
      }),
    ),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000,
        description: 'Maximum number of matching file paths to return.',
      }),
    ),
  },
  { additionalProperties: false },
)

const GrepArgsSchema = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      maxLength: 2_048,
      description: 'Regular expression pattern to search for.',
    }),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative file/directory or absolute Session-temp path to search. Omit for workspace root.',
      }),
    ),
    include: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1_024,
        description:
          'Bash-style glob relative to path for files to search, for example **/*.{ts,tsx}. Defaults to **/*.',
      }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description: 'Set true for case-sensitive matching.',
      }),
    ),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000,
        description: 'Maximum number of matches to return.',
      }),
    ),
  },
  { additionalProperties: false },
)

function workspaceGuard(
  canonicalPath: string,
  sessionTempPath?: string,
): PathGuard {
  return PathGuard.fromCanonical(canonicalPath, sessionTempPath)
}

function errorResult(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error instanceof PathGuardError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'TOOL_FAILED',
    message: error instanceof Error ? error.message : 'Read-only tool failed',
    retryable: false,
  }
}

/** Creates definitions for bounded read-only workspace, search, and metadata tools. */
export function createReadOnlyToolDefinitions(
  getLimits: () => Pick<
    PublicConfig['limits'],
    'maxToolOutputBytes' | 'maxToolOutputLines' | 'readFileSourceBytes'
  > = () => DEFAULT_LIMITS,
  getSearcher: () => Promise<Searcher> = resolveWorkspaceSearcher,
): ToolDefinition[] {
  const readFileTool: ToolDefinition<typeof ReadFileArgsSchema> = {
    id: 'read_file',
    executionMode: 'parallel',
    description:
      'Stream a bounded UTF-8 page from a workspace or Session-temp file. Continue with nextStartLine and, only for a split long line, nextStartCharacter. Use tail for a bounded final snapshot.',
    inputSchema: ReadFileArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    modelOutputPolicy: 'paged',
    projectResultForModel: projectReadFileResult,
    validateArgs(args) {
      return args.tail === true &&
        (args.startLine !== undefined || args.startCharacter !== undefined)
        ? 'read_file tail cannot be combined with startLine or startCharacter'
        : undefined
    },
    async execute(args, context) {
      try {
        const guard = workspaceGuard(
          context.workspace.canonicalPath,
          context.sessionTemp?.root,
        )
        const configuredLimits = getLimits()
        const outputLimits = context.toolOutputLimits ?? configuredLimits
        const bodyLineLimit =
          outputLimits.maxToolOutputLines <= 2
            ? 1
            : outputLimits.maxToolOutputLines - 2
        const result = await readStreamingFile({
          guard,
          inputPath: args.path,
          startLine: args.startLine,
          startCharacter: args.startCharacter,
          tail: args.tail,
          lineCount: Math.min(args.lineCount ?? bodyLineLimit, bodyLineLimit),
          lineNumbers: args.lineNumbers ?? true,
          maxOutputBytes: Math.max(
            1,
            outputLimits.maxToolOutputBytes - READ_FILE_METADATA_RESERVE_BYTES,
          ),
          projectionLineLimit: outputLimits.maxToolOutputLines,
          maxWorkspaceSourceBytes: configuredLimits.readFileSourceBytes,
          signal: context.signal,
        })
        return {
          status: 'ok',
          ...result,
        }
      } catch (error) {
        if (
          error instanceof PathGuardError &&
          error.code === 'PATH_NOT_FOUND' &&
          context.sessionTemp &&
          path.isAbsolute(args.path) &&
          (() => {
            try {
              return (
                workspaceGuard(
                  context.workspace.canonicalPath,
                  context.sessionTemp.root,
                ).rootForCandidate(args.path).kind === 'session-temp'
              )
            } catch {
              return false
            }
          })()
        ) {
          return {
            status: 'error',
            code: 'ARTIFACT_EXPIRED',
            message: 'The Session artifact no longer exists',
            retryable: false,
          }
        }
        return errorResult(error)
      }
    },
  }

  const listDirTool: ToolDefinition<typeof ListDirArgsSchema> = {
    id: 'list_dir',
    executionMode: 'parallel',
    description:
      'List files and directories inside the workspace or current Session temp. Recursive listing skips symlinks and large generated folders.',
    inputSchema: ListDirArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    projectResultForModel: projectListDirResult,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(
          context.workspace.canonicalPath,
          context.sessionTemp?.root,
        )
        const maxEntries = args.maxEntries ?? DEFAULT_MAX_ENTRIES

        if (!args.recursive) {
          const entries = (await guard.listDirectory(args.path ?? '.')).slice(
            0,
            maxEntries,
          )
          const content: JsonValue = {
            path: args.path ?? '.',
            entries: entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              type: entry.type,
            })),
            truncated: entries.length >= maxEntries,
          }

          return {
            status: 'ok',
            content,
          }
        }

        const walked = await walkFiles(
          guard,
          args.path ?? '.',
          maxEntries,
          context.signal,
        )

        const content: JsonValue = {
          path: args.path ?? '.',
          entries: walked.files.map((file) => ({
            path: file.path,
            type: 'file',
          })),
          truncated: walked.truncated,
        }

        return {
          status: 'ok',
          content,
          truncated: walked.truncated,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const globTool: ToolDefinition<typeof GlobArgsSchema> = {
    id: 'glob',
    executionMode: 'parallel',
    description:
      'Find files under a workspace-relative or absolute Session-temp directory with a Bash-style glob. Supports globstar, braces, character classes, and extglobs. Symlinks are not followed.',
    inputSchema: GlobArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    projectResultForModel: projectGlobResult,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(
          context.workspace.canonicalPath,
          context.sessionTemp?.root,
        )
        const maxResults = args.maxResults ?? DEFAULT_MAX_ENTRIES
        const matches: string[] = []
        let truncated = false
        for await (const match of iterateWorkspaceGlobFiles({
          guard,
          rootInput: args.path ?? '.',
          pattern: args.pattern,
          signal: context.signal,
        })) {
          if (matches.length >= maxResults) {
            truncated = true
            break
          }
          matches.push(match)
        }
        matches.sort((left, right) => left.localeCompare(right))

        return {
          status: 'ok',
          content: {
            pattern: args.pattern,
            matches,
            truncated,
          },
          truncated,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const grepTool: ToolDefinition<typeof GrepArgsSchema> = {
    id: 'grep',
    executionMode: 'parallel',
    description:
      'Search text files in the workspace or current Session temp using a regular expression. Prefers ripgrep and falls back to an in-process engine when unavailable.',
    inputSchema: GrepArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    projectResultForModel: projectGrepResult,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(
          context.workspace.canonicalPath,
          context.sessionTemp?.root,
        )
        const maxResults = args.maxResults ?? DEFAULT_MAX_ENTRIES
        const include = args.include ?? '**/*'
        const searcher = await getSearcher()
        const outcome = await searcher.search({
          pattern: args.pattern,
          caseSensitive: Boolean(args.caseSensitive),
          guard,
          rootInput: args.path ?? '.',
          include,
          maxResults,
          signal: context.signal,
        })

        const content: JsonValue = {
          pattern: args.pattern,
          include,
          matches: outcome.matches.map((match) => ({
            path: match.path,
            line: match.line,
            text: match.text,
          })),
          truncated: outcome.truncated,
        }

        return {
          status: 'ok',
          content,
          truncated: outcome.truncated,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  return [readFileTool, listDirTool, globTool, grepTool]
}

/** Registers all read-only tool definitions with the ToolRegistry. */
export function registerReadOnlyTools(
  registry: ToolRegistry,
  getLimits?: () => Pick<
    PublicConfig['limits'],
    'maxToolOutputBytes' | 'maxToolOutputLines' | 'readFileSourceBytes'
  >,
  getSearcher?: () => Promise<Searcher>,
): void {
  for (const definition of createReadOnlyToolDefinitions(
    getLimits,
    getSearcher,
  )) {
    registry.registerTool(definition)
  }
}
