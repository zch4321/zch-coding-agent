import { Type, type Static } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'
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

/**
 * Validate a positional Git reference (revision range or object ref). Anything
 * starting with "-" is rejected so a caller cannot inject Git options such as
 * `--output=<path>` through a field registered as read-only.
 */
function assertRef(
  value: string,
  field: string,
  toolId: string,
): string | undefined {
  if (value.startsWith('-')) {
    return `${toolId} ${field} must not be a git option: ${value.slice(0, 64)}`
  }

  // Revision ranges may contain "..", "...", "^", "~", but not shell/path
  // separators that could smuggle a worktree pathspec past the guard.
  if (/[|;&\r\n]/u.test(value)) {
    return `${toolId} ${field} contains forbidden characters`
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
        fixedArgs: ['--no-ext-diff', '--no-textconv'],
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
      let revision: string[] = []

      if (args.revision) {
        const refError = assertRef(args.revision, 'revision', 'git_log')
        if (refError) {
          return {
            status: 'error',
            code: 'INVALID_ARGS',
            message: refError,
            retryable: false,
          }
        }
        revision = ['--end-of-options', args.revision]
      }

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

      const refError = assertRef(args.ref, 'ref', 'git_show')
      if (refError) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: refError,
          retryable: false,
        }
      }

      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'show',
        args: [...flags, '--end-of-options', args.ref],
        fixedArgs: ['--no-ext-diff', '--no-textconv'],
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

const GitAddSchema = Type.Object(
  {
    paths: PATHS_FIELD,
    all: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
type GitAddArgs = Static<typeof GitAddSchema>

const GitCommitSchema = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    amend: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
type GitCommitArgs = Static<typeof GitCommitSchema>

const GitRestoreSchema = Type.Object(
  {
    paths: PATHS_FIELD,
    staged: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
type GitRestoreArgs = Static<typeof GitRestoreSchema>

/**
 * Deterministic policy signals for the dedicated git write tools live in
 * file-tool-policy.ts (gitPolicySignals) so they share the argsObject helper
 * and are merged into the tool resource plan alongside processPolicySignals.
 */

export function registerGitWriteTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
): void {
  const gitAdd: ToolDefinition<typeof GitAddSchema> = {
    id: 'git_add',
    description:
      'Stage file paths in the working tree. Use all=true to stage every change (higher risk).',
    inputSchema: GitAddSchema,
    effects: ['process.spawn', 'vcs.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: GitAddArgs, context): Promise<ToolResult> {
      if (args.all && args.paths && args.paths.length > 0) {
        return {
          status: 'error',
          code: 'INVALID_ARGS',
          message: 'git_add all=true cannot be combined with paths',
          retryable: false,
        }
      }

      const paths = args.paths ?? []
      for (const candidate of paths) {
        if (candidate.startsWith('-')) {
          return {
            status: 'error',
            code: 'INVALID_ARGS',
            message: `git_add path must not be a git option: ${candidate.slice(0, 64)}`,
            retryable: false,
          }
        }
      }

      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      // `--` separates options from pathspecs so a path value like `-A` is
      // treated as a literal path, never re-parsed as `git add -A`.
      const addArgs = args.all ? ['-A'] : ['--', ...paths]
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'add',
        args: addArgs,
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  const gitCommit: ToolDefinition<typeof GitCommitSchema> = {
    id: 'git_commit',
    description:
      'Create a commit from the staged changes. Hooks are disabled (--no-verify) so commit-time side effects never run silently. amend=true rewrites the previous commit (high risk).',
    inputSchema: GitCommitSchema,
    effects: ['process.spawn', 'vcs.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: GitCommitArgs, context): Promise<ToolResult> {
      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      const amend = args.amend ? ['--amend'] : []
      // --no-verify prevents commit hooks from running unapproved side effects.
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'commit',
        args: ['--no-verify', '-m', args.message, ...amend],
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  const gitRestore: ToolDefinition<typeof GitRestoreSchema> = {
    id: 'git_restore',
    description:
      'Restore working tree files, discarding uncommitted changes (default, high risk). staged=true restores the index instead (unstage).',
    inputSchema: GitRestoreSchema,
    effects: ['process.spawn', 'vcs.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args: GitRestoreArgs, context): Promise<ToolResult> {
      const { timeoutMs, maxOutputBytes } = timeoutAndOutput(getConfig)
      const staged = args.staged ? ['--staged'] : []
      const paths = args.paths ?? []
      return runGit({
        workspace: context.workspace.canonicalPath,
        subcommand: 'restore',
        args: [...staged, '--', ...paths],
        signal: context.signal,
        timeoutMs,
        maxOutputBytes,
      })
    },
  }

  registry.registerTool(gitAdd)
  registry.registerTool(gitCommit)
  registry.registerTool(gitRestore)
}
