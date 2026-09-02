import path from 'node:path'
import type {
  GitReviewDiff,
  GitReviewMode,
  GitReviewStatus,
  GitReviewStatusEntry,
  GitReviewStatusKind,
} from '../../shared/git-review'
import { inspectPath } from '../common/filesystem'
import { PathGuardError } from '../safety/path-guard'
import { runCommand, type RunCommandResult } from '../process/run'
import { ApplicationError } from './application-error'

const GIT_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.pager=',
  '-c',
  'color.ui=never',
] as const
const COMMAND_TIMEOUT_MS = 15_000
const METADATA_OUTPUT_BYTES = 1_000_000
const DIFF_OUTPUT_BYTES = 900_000
const MAX_STATUS_ENTRIES = 10_000
const MAX_BASE_REFS = 500

interface GitCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
  totalBytes: number
  stdoutBytes: number
}

interface RepositoryContext {
  workspace: string
  topLevel: string
  scope: string
  headOid?: string
}

/** Provides bounded, read-only Git status and diff queries for the renderer. */
export class GitReviewService {
  /** Returns live Git repository metadata and working-tree status for a Project. */
  async getStatus(workspace: string): Promise<GitReviewStatus> {
    const rootResult = await runGit(workspace, ['rev-parse', '--show-toplevel'])
    if (!succeeded(rootResult)) {
      if (isNotRepository(rootResult)) {
        return emptyStatus(workspace)
      }
      throw gitFailure('Unable to inspect the Git repository', rootResult)
    }

    const topLevel = path.resolve(rootResult.stdout.trim())
    const canonicalWorkspace = await canonicalDirectory(workspace)
    const scope = projectScope(topLevel, canonicalWorkspace)
    const [
      headRefResult,
      headOidResult,
      upstreamResult,
      refsResult,
      statusResult,
    ] = await Promise.all([
      runGit(topLevel, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(topLevel, ['rev-parse', '--verify', 'HEAD^{commit}']),
      runGit(topLevel, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]),
      runGit(topLevel, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
        'refs/remotes',
      ]),
      runGit(topLevel, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        scope,
      ]),
    ])

    if (!succeeded(statusResult)) {
      throw gitFailure('Unable to read the Git working tree', statusResult)
    }

    const headRef = succeeded(headRefResult)
      ? nonEmpty(headRefResult.stdout)
      : undefined
    const headOid = succeeded(headOidResult)
      ? nonEmpty(headOidResult.stdout)
      : undefined
    const upstreamRef = succeeded(upstreamResult)
      ? nonEmpty(upstreamResult.stdout)
      : undefined
    const parsed = parsePorcelainStatus(statusResult.stdout)

    return {
      repository: true,
      workspace: canonicalWorkspace,
      topLevel,
      ...(headRef ? { headRef } : {}),
      ...(headOid ? { headOid } : {}),
      ...(upstreamRef ? { upstreamRef } : {}),
      detached: Boolean(headOid && !headRef),
      unborn: !headOid,
      baseRefs: succeeded(refsResult)
        ? uniqueLines(refsResult.stdout).slice(0, MAX_BASE_REFS)
        : [],
      entries: parsed.entries,
      truncated:
        statusResult.truncated ||
        parsed.truncated ||
        (succeeded(refsResult) && refsResult.truncated),
    }
  }

  /** Returns a bounded live Git diff for one Project scope or changed path. */
  async getDiff(input: {
    workspace: string
    mode: GitReviewMode
    path?: string
    baseRef?: string
    contextLines?: number
  }): Promise<GitReviewDiff> {
    const repository = await repositoryContext(input.workspace)
    const selectedPath = input.path
      ? validateSelectedPath(repository, input.path)
      : repository.scope
    const contextLines = input.contextLines ?? 3
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      `--unified=${contextLines}`,
    ]
    let baseRef: string | undefined
    let baseOid: string | undefined

    if (input.mode === 'head') {
      if (!repository.headOid) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'The repository does not have a HEAD commit yet',
        )
      }
      args.push('HEAD')
    } else if (input.mode === 'staged') {
      args.push('--cached')
    } else if (input.mode === 'merge_base') {
      baseRef = validateBaseRef(input.baseRef)
      if (!repository.headOid) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'A merge-base diff requires a HEAD commit',
        )
      }
      const resolved = await runGit(repository.topLevel, [
        'rev-parse',
        '--verify',
        `${baseRef}^{commit}`,
      ])
      if (!succeeded(resolved)) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          `Git reference ${baseRef} could not be resolved`,
        )
      }
      const mergeBase = await runGit(repository.topLevel, [
        'merge-base',
        'HEAD',
        resolved.stdout.trim(),
      ])
      if (!succeeded(mergeBase) || !nonEmpty(mergeBase.stdout)) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          `No merge base exists between HEAD and ${baseRef}`,
        )
      }
      baseOid = mergeBase.stdout.trim()
      args.push(baseOid)
    }

    args.push('--', selectedPath)
    const result = await runGit(repository.topLevel, args, DIFF_OUTPUT_BYTES)
    if (!succeeded(result)) {
      throw gitFailure('Unable to read the Git diff', result)
    }

    return {
      mode: input.mode,
      ...(input.path ? { path: input.path } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(baseOid ? { baseOid } : {}),
      content: result.stdout,
      totalBytes: result.stdoutBytes,
      truncated: result.truncated,
      binary:
        /^Binary files .* differ$/mu.test(result.stdout) ||
        /^GIT binary patch$/mu.test(result.stdout),
    }
  }
}

async function repositoryContext(
  workspace: string,
): Promise<RepositoryContext> {
  const rootResult = await runGit(workspace, ['rev-parse', '--show-toplevel'])
  if (!succeeded(rootResult)) {
    throw isNotRepository(rootResult)
      ? new ApplicationError(
          'PRECONDITION_FAILED',
          'Project is not a Git repository',
        )
      : gitFailure('Unable to inspect the Git repository', rootResult)
  }
  const topLevel = path.resolve(rootResult.stdout.trim())
  const canonicalWorkspace = await canonicalDirectory(workspace)
  const headResult = await runGit(topLevel, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ])
  return {
    workspace: canonicalWorkspace,
    topLevel,
    scope: projectScope(topLevel, canonicalWorkspace),
    ...(succeeded(headResult) && nonEmpty(headResult.stdout)
      ? { headOid: headResult.stdout.trim() }
      : {}),
  }
}

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const inspected = await inspectPath(directoryPath)
  if (!inspected || inspected.type !== 'directory') {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Project workspace is not an available directory',
    )
  }
  return path.resolve(inspected.realPath)
}

async function runGit(
  workspace: string,
  args: string[],
  maxOutputBytes = METADATA_OUTPUT_BYTES,
): Promise<GitCommandResult> {
  const controller = new AbortController()
  let result: RunCommandResult
  try {
    result = await runCommand({
      workspace,
      command: {
        mode: 'process',
        executable: 'git',
        args: [...GIT_ARGS, ...args],
      },
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof PathGuardError) {
      throw new ApplicationError('PRECONDITION_FAILED', error.message)
    }
    throw error
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    totalBytes: result.totalBytes,
    stdoutBytes: result.stdoutBytes,
  }
}

function succeeded(result: GitCommandResult): boolean {
  return result.exitCode === 0
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed || undefined
}

function isNotRepository(result: GitCommandResult): boolean {
  return /not a git repository|outside repository/iu.test(
    `${result.stderr}\n${result.stdout}`,
  )
}

function gitFailure(
  message: string,
  result: GitCommandResult,
): ApplicationError {
  const diagnostic = nonEmpty(result.stderr) ?? nonEmpty(result.stdout)
  return new ApplicationError(
    'PRECONDITION_FAILED',
    diagnostic ? `${message}: ${diagnostic.slice(0, 2_000)}` : message,
  )
}

function emptyStatus(workspace: string): GitReviewStatus {
  return {
    repository: false,
    workspace,
    detached: false,
    unborn: false,
    baseRefs: [],
    entries: [],
    truncated: false,
  }
}

function projectScope(topLevel: string, workspace: string): string {
  const relative = path.relative(topLevel, path.resolve(workspace))
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Project path is outside the detected Git worktree',
    )
  }
  return relative.split(path.sep).join('/') || '.'
}

function validateSelectedPath(
  repository: RepositoryContext,
  selectedPath: string,
): string {
  if (
    selectedPath.includes('\0') ||
    path.isAbsolute(selectedPath) ||
    selectedPath.split(/[\\/]/u).includes('..')
  ) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Invalid Git path')
  }
  const normalized = selectedPath.replace(/\\/gu, '/')
  if (
    repository.scope !== '.' &&
    normalized !== repository.scope &&
    !normalized.startsWith(`${repository.scope}/`)
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Git path is outside the Project scope',
    )
  }
  return normalized
}

function validateBaseRef(value: string | undefined): string {
  const ref = value?.trim()
  if (!ref || ref.startsWith('-') || /[\0\r\n|;&]/u.test(ref)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'A valid base Git reference is required',
    )
  }
  return ref
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map((line) => line.trim()))].filter(
    Boolean,
  )
}

function parsePorcelainStatus(value: string): {
  entries: GitReviewStatusEntry[]
  truncated: boolean
} {
  const fields = value.split('\0')
  const entries: GitReviewStatusEntry[] = []
  let fieldIndex = 0
  while (fieldIndex < fields.length && entries.length < MAX_STATUS_ENTRIES) {
    const field = fields[fieldIndex++]
    if (!field) continue
    if (field.length < 4 || field[2] !== ' ') continue
    const indexStatus = field[0] ?? ' '
    const worktreeStatus = field[1] ?? ' '
    const currentPath = field.slice(3)
    const renamed = indexStatus === 'R' || worktreeStatus === 'R'
    const copied = indexStatus === 'C' || worktreeStatus === 'C'
    const originalPath = renamed || copied ? fields[fieldIndex++] : undefined
    if (!currentPath) continue
    entries.push({
      path: currentPath,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      worktreeStatus,
      kind: statusKind(indexStatus, worktreeStatus),
    })
  }
  return {
    entries,
    truncated:
      entries.length >= MAX_STATUS_ENTRIES || fieldIndex < fields.length - 1,
  }
}

function statusKind(
  indexStatus: string,
  worktreeStatus: string,
): GitReviewStatusKind {
  const combined = `${indexStatus}${worktreeStatus}`
  if (combined === '??') return 'untracked'
  if (combined === '!!') return 'ignored'
  if (/U|AA|DD/u.test(combined)) return 'unmerged'
  if (combined.includes('R')) return 'renamed'
  if (combined.includes('C')) return 'copied'
  if (combined.includes('D')) return 'deleted'
  if (combined.includes('A')) return 'added'
  if (combined.includes('T')) return 'type_changed'
  if (combined.includes('M')) return 'modified'
  return 'unknown'
}
