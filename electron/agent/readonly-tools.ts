import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { JsonValue } from '../../shared/json'
import type { PublicConfig } from '../../shared/config'
import type { ToolDefinition, ToolResult } from '../tools/types'
import { matchesGlob, normalizePortablePath } from './glob'
import { PathGuard, PathGuardError } from './path-guard'
import type { ToolRegistry } from './tool-registry'
import { estimateTextTokens, truncateTextHeadTail } from './context-budget'
import { BoundedRegexSearcher } from './regex-search'

const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_GREP_FILE_BYTES = 256_000
const MAX_READ_SOURCE_BYTES = 10_000_000
const MAX_READ_OUTPUT_BYTES = 64 * 1_024
const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 1_000
const DEFAULT_LIMITS: Pick<
  PublicConfig['limits'],
  | 'maxToolResultTokens'
  | 'tokenEstimation'
  | 'readFileSourceBytes'
  | 'readFileOutputBytes'
> = {
  maxToolResultTokens: 8_000,
  tokenEstimation: { mode: 'conservative', bytesPerToken: 3 },
  readFileSourceBytes: MAX_READ_SOURCE_BYTES,
  readFileOutputBytes: MAX_READ_OUTPUT_BYTES,
}

const ReadFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
    lineCount: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_READ_LINES }),
    ),
  },
  { additionalProperties: false },
)

const ListDirArgsSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    recursive: Type.Optional(Type.Boolean()),
    maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  },
  { additionalProperties: false },
)

const GlobArgsSchema = Type.Object(
  {
    pattern: Type.String({ minLength: 1, maxLength: 1_024 }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  },
  { additionalProperties: false },
)

const GrepArgsSchema = Type.Object(
  {
    pattern: Type.String({ minLength: 1, maxLength: 2_048 }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    include: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  },
  { additionalProperties: false },
)

interface WalkedFile {
  path: string
}

function workspaceGuard(canonicalPath: string): PathGuard {
  return PathGuard.fromCanonical(canonicalPath)
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

async function walkFiles(
  guard: PathGuard,
  rootInput: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const root = await guard.resolveExisting(rootInput)
  const files: WalkedFile[] = []
  const directories = [root.realPath]
  let truncated = false

  while (directories.length > 0) {
    if (signal?.aborted) {
      throw signal.reason
    }

    const current = directories.pop()

    if (!current) {
      break
    }

    const entries = await readdir(current, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)
      const relativePath = normalizePortablePath(
        path.relative(guard.workspacePath, absolutePath),
      )

      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist'
        ) {
          continue
        }

        directories.push(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      guard.assertInside(absolutePath)
      files.push({ path: relativePath })

      if (files.length >= maxResults) {
        truncated = true
        return { files, truncated }
      }
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, truncated }
}

export function createReadOnlyToolDefinitions(
  getLimits: () => Pick<
    PublicConfig['limits'],
    | 'maxToolResultTokens'
    | 'tokenEstimation'
    | 'readFileSourceBytes'
    | 'readFileOutputBytes'
  > = () => DEFAULT_LIMITS,
): ToolDefinition[] {
  const readFileTool: ToolDefinition<typeof ReadFileArgsSchema> = {
    id: 'read_file',
    description:
      'Read a bounded line range from a UTF-8 workspace file. Continue with nextStartLine when truncated.',
    inputSchema: ReadFileArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    maxOutputBytes: 96 * 1_024,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(context.workspace.canonicalPath)
        const limits = getLimits()
        const maxSourceBytes = Math.min(
          limits.readFileSourceBytes,
          MAX_READ_SOURCE_BYTES,
        )
        const maxOutputBytes = Math.min(
          limits.readFileOutputBytes,
          MAX_READ_OUTPUT_BYTES,
        )
        const source = await guard.readFileBounded(
          args.path,
          maxSourceBytes,
          context.signal,
        )

        if (source.truncated) {
          return {
            status: 'error',
            code: 'FILE_TOO_LARGE',
            message: `read_file supports files up to ${maxSourceBytes} bytes`,
            retryable: false,
          }
        }

        const lines =
          source.content.length === 0 ? [] : source.content.split(/\r?\n/u)

        if (/\r?\n$/u.test(source.content)) {
          lines.pop()
        }
        const requestedStartLine = args.startLine ?? 1
        const startIndex = Math.min(requestedStartLine - 1, lines.length)
        const requestedLines = args.lineCount ?? DEFAULT_READ_LINES
        const maxTokens = Math.min(8_000, limits.maxToolResultTokens)
        const selected: string[] = []
        let selectedBytes = 0
        let selectedTokens = 0
        let lineTruncated = false

        for (
          let index = startIndex;
          index < lines.length && selected.length < requestedLines;
          index += 1
        ) {
          const separator = selected.length === 0 ? '' : '\n'
          const candidate = `${separator}${lines[index]}`
          const candidateBytes = Buffer.byteLength(candidate, 'utf8')
          const candidateTokens = estimateTextTokens(
            candidate,
            limits.tokenEstimation,
          )

          if (
            selectedBytes + candidateBytes > maxOutputBytes ||
            selectedTokens + candidateTokens > maxTokens
          ) {
            if (selected.length === 0) {
              const byteBounded = Buffer.from(lines[index]).subarray(
                0,
                maxOutputBytes,
              )
              selected.push(
                truncateTextHeadTail(
                  new TextDecoder().decode(byteBounded),
                  maxTokens,
                  limits.tokenEstimation,
                ),
              )
              lineTruncated = true
            }
            break
          }

          selected.push(lines[index])
          selectedBytes += candidateBytes
          selectedTokens += candidateTokens
        }

        const endLine =
          selected.length === 0
            ? undefined
            : requestedStartLine + selected.length - 1
        const hasMore =
          lineTruncated || startIndex + selected.length < lines.length
        const result: JsonValue = {
          path: source.path,
          content: selected.join('\n'),
          startLine: requestedStartLine,
          endLine: endLine ?? null,
          totalLines: lines.length,
          truncated: hasMore,
          lineTruncated,
          ...(hasMore && endLine !== undefined
            ? { nextStartLine: endLine + 1 }
            : {}),
        }

        return {
          status: 'ok',
          content: result,
          truncated: hasMore,
          totalBytes: source.totalBytes,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const listDirTool: ToolDefinition<typeof ListDirArgsSchema> = {
    id: 'list_dir',
    description:
      'List files and directories inside the workspace. Recursive listing skips symlinks and large generated folders.',
    inputSchema: ListDirArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(context.workspace.canonicalPath)
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
    description:
      'Find workspace files matching a glob pattern such as **/*.ts. Symlinks are not followed.',
    inputSchema: GlobArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(context.workspace.canonicalPath)
        const walked = await walkFiles(
          guard,
          args.path ?? '.',
          args.maxResults ?? DEFAULT_MAX_ENTRIES,
          context.signal,
        )
        const matches = walked.files
          .filter((file) => matchesGlob(args.pattern, file.path))
          .map((file) => file.path)

        return {
          status: 'ok',
          content: {
            pattern: args.pattern,
            matches,
            truncated: walked.truncated,
          },
          truncated: walked.truncated,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const grepTool: ToolDefinition<typeof GrepArgsSchema> = {
    id: 'grep',
    description:
      'Search text files in the workspace using a JavaScript regular expression.',
    inputSchema: GrepArgsSchema,
    effects: ['filesystem.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args, context) {
      try {
        const guard = workspaceGuard(context.workspace.canonicalPath)
        const maxResults = args.maxResults ?? DEFAULT_MAX_ENTRIES
        const walked = await walkFiles(
          guard,
          args.path ?? '.',
          maxResults * 10,
          context.signal,
        )
        const include = args.include ?? '**/*'
        const matches: Array<{
          path: string
          line: number
          text: string
        }> = []
        const searcher = new BoundedRegexSearcher()

        try {
          for (const file of walked.files) {
            if (matches.length >= maxResults) {
              break
            }

            if (!matchesGlob(include, file.path)) {
              continue
            }

            const source = await guard
              .readFileBounded(
                file.path,
                DEFAULT_GREP_FILE_BYTES,
                context.signal,
              )
              .catch(() => undefined)

            if (!source) {
              continue
            }

            const fileMatches = await searcher.search({
              pattern: args.pattern,
              caseSensitive: Boolean(args.caseSensitive),
              content: source.content,
              maxResults: maxResults - matches.length,
              signal: context.signal,
            })

            for (const match of fileMatches) {
              matches.push({
                path: file.path,
                line: match.line,
                text: match.text,
              })
            }
          }
        } finally {
          await searcher.close()
        }

        return {
          status: 'ok',
          content: {
            pattern: args.pattern,
            include,
            matches,
            truncated: walked.truncated || matches.length >= maxResults,
          },
          truncated: walked.truncated || matches.length >= maxResults,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  return [readFileTool, listDirTool, globTool, grepTool]
}

export function registerReadOnlyTools(
  registry: ToolRegistry,
  getLimits?: () => Pick<
    PublicConfig['limits'],
    | 'maxToolResultTokens'
    | 'tokenEstimation'
    | 'readFileSourceBytes'
    | 'readFileOutputBytes'
  >,
): void {
  for (const definition of createReadOnlyToolDefinitions(getLimits)) {
    registry.registerTool(definition)
  }
}
