import { Type, type Static } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type {
  ToolDefinition,
  ToolRegistrationPort,
  ToolResult,
} from '../tools/types'
import {
  runCommand,
  type CommandSpec,
  type RunCommandResult,
} from '../process/run'

/**
 * Common git prefix so the pager, colour output and external diff tooling
 * never run inside the agent loop (the roadmap requires git commands to
 * disable the pager and forbid external diff tools).
 */
const GIT_BASE_ARGS = [
  '--no-pager',
  '-c',
  'core.pager=',
  '-c',
  'color.ui=never',
]

const FLAGS_FIELD = Type.Optional(
  Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 }),
)
const PATHS_FIELD = Type.Optional(
  Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 64 }),
)

function assertFlagsAllowed(
  flags: string[],
  allowed: readonly string[],
  toolId: string,
): string | undefined {
  for (const flag of flags) {
    if (flag.startsWith('-') && !allowed.includes(flag)) {
      return `${toolId} does not allow flag ${flag}`
    }
  }

  return undefined
}

function gitResultContent(result: RunCommandResult): JsonValue {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
  }
}

interface RunGitOptions {
  workspace: string
  subcommand: string
  /** Validated argument vector appended after the subcommand and fixed args. */
  args: string[]
  fixedArgs?: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}

async function runGit(options: RunGitOptions): Promise<ToolResult> {
  const command: CommandSpec = {
    mode: 'process',
    executable: 'git',
    args: [
      ...GIT_BASE_ARGS,
      options.subcommand,
      ...(options.fixedArgs ?? []),
      ...options.args,
    ],
  }

  const result = await runCommand({
    workspace: options.workspace,
    command,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  })

  if (result.cancelled || options.signal.aborted) {
    return { status: 'cancelled', message: 'The git command was cancelled' }
  }

  if (result.timedOut) {
    return {
      status: 'timeout',
      message: `git ${options.subcommand} timed out after ${Math.round(result.durationMs)} ms`,
    }
  }

  if (result.exitCode !== null && result.exitCode !== 0) {
    return {
      status: 'error',
      code: 'GIT_FAILED',
      message: `git ${options.subcommand} exited with ${result.exitCode}`,
      retryable: false,
    }
  }

  return {
    status: 'ok',
    content: gitResultContent(result),
    truncated: result.truncated,
    totalBytes: result.totalBytes,
  }
}

const GitStatusSchema = Type.Object(
  {
    flags: FLAGS_FIELD,
  },
  { additionalProperties: false },
)
type GitStatusArgs = Static<typeof GitStatusSchema>

const GitDiffSchema = Type.Object(
  {
    flags: FLAGS_FIELD,
    paths: PATHS_FIELD,
  },
  { additionalProperties: false },
)
type GitDiffArgs = Static<typeof GitDiffSchema>

const GitLogSchema = Type.Object(
  {
    flags: FLAGS_FIELD,
    revision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
)
type GitLogArgs = Static<typeof GitLogSchema>

const GitShowSchema = Type.Object(
  {
    flags: FLAGS_FIELD,
    ref: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
)
type GitShowArgs = Static<typeof GitShowSchema>

const GIT_STATUS_FLAGS = [
  '--short',
  '-s',
  '--porcelain',
  '--branch',
  '--untracked-files=normal',
  '--untracked-files=all',
  '-uall',
]
const GIT_DIFF_FLAGS = [
  '--stat',
  '--name-only',
  '--cached',
  '--staged',
  '--name-status',
]
const GIT_LOG_FLAGS = ['--oneline', '--stat', '--name-only', '--no-merges']
const GIT_SHOW_FLAGS = ['--stat', '--name-only', '--name-status', '--no-patch']

function timeoutAndOutput(getConfig: () => PublicConfig): {
  timeoutMs: number
  maxOutputBytes: number
} {
  const limits = getConfig().limits
  return {
    timeoutMs: Math.min(limits.commandTimeoutMs, 30_000),
    maxOutputBytes: Math.min(limits.maxToolOutputBytes, 64 * 1_024),
  }
}

export function registerGitReadOnlyTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
): void {
  const gitStatus: ToolDefinition<typeof GitStatusSchema> = {
    id: 'git_status',
    description:
      'Show the working tree status (read-only). Accepts --short/--porcelain/--branch/--untracked-files=normal.',
    inputSchema: GitStatusSchema,
    effects: ['vcs.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args: GitStatusArgs, context): Promise<ToolResult> {
      const flags = args.flags ?? []
      const flagError = assertFlagsAllowed(
        flags,
        GIT_STATUS_FLAGS,
        'git_status',
      )
      if (flagError) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: flagError,
          retryable: false,
        }
      }

      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'status',
        args: flags,
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  const gitDiff: ToolDefinition<typeof GitDiffSchema> = {
    id: 'git_diff',
    description:
      'Show changes between commits, the working tree and the index (read-only). Accepts --stat/--name-only/--cached and optional pathspecs.',
    inputSchema: GitDiffSchema,
    effects: ['vcs.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args: GitDiffArgs, context): Promise<ToolResult> {
      const flags = args.flags ?? []
      const flagError = assertFlagsAllowed(flags, GIT_DIFF_FLAGS, 'git_diff')
      if (flagError) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: flagError,
          retryable: false,
        }
      }

      const paths = args.paths ?? []
      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'diff',
        args: [...flags, '--', ...paths],
        fixedArgs: ['--no-ext-diff'],
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  const gitLog: ToolDefinition<typeof GitLogSchema> = {
    id: 'git_log',
    description:
      'Show commit history (read-only). Accepts --oneline/--stat/--no-merges, an optional revision range and -n <count>.',
    inputSchema: GitLogSchema,
    effects: ['vcs.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args: GitLogArgs, context): Promise<ToolResult> {
      const flags = args.flags ?? []
      const flagError = assertFlagsAllowed(flags, GIT_LOG_FLAGS, 'git_log')
      if (flagError) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: flagError,
          retryable: false,
        }
      }

      const limit = args.limit ? ['-n', String(args.limit)] : []
      const revision = args.revision ? [args.revision] : []
      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)

      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'log',
        args: [...flags, ...limit, ...revision],
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  const gitShow: ToolDefinition<typeof GitShowSchema> = {
    id: 'git_show',
    description:
      'Show the contents of a commit, tag or object (read-only). Accepts --stat/--name-only/--no-patch and a required ref.',
    inputSchema: GitShowSchema,
    effects: ['vcs.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args: GitShowArgs, context): Promise<ToolResult> {
      const flags = args.flags ?? []
      const flagError = assertFlagsAllowed(flags, GIT_SHOW_FLAGS, 'git_show')
      if (flagError) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: flagError,
          retryable: false,
        }
      }

      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'show',
        args: [...flags, args.ref],
        fixedArgs: ['--no-ext-diff'],
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  registry.registerTool(gitStatus)
  registry.registerTool(gitDiff)
  registry.registerTool(gitLog)
  registry.registerTool(gitShow)
}
