import { fileStatus as stat } from '../common/filesystem'
import path from 'node:path'
import type { Readable } from 'node:stream'
import fastGlob from 'fast-glob'
import { normalizePortablePath } from './portable-path'
import { PathGuard, PathGuardError } from '../safety/path-guard'

const IGNORED_DIRECTORY_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
]
const PARENT_SEGMENT_PATTERN = /(?:^|[/{,(|])\.\.(?=$|[/},)|])/u

/** Reports invalid or unsafe workspace glob patterns. */
class WorkspaceGlobError extends Error {
  readonly code = 'INVALID_GLOB'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceGlobError'
  }
}

interface WorkspaceGlobInput {
  guard: PathGuard
  rootInput: string
  pattern: string
  signal: AbortSignal
  baseNameMatch?: boolean
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Workspace glob was cancelled')
}

function normalizePattern(pattern: string): string {
  if (pattern.includes('\0')) {
    throw new WorkspaceGlobError('Glob pattern cannot contain null bytes')
  }

  const normalized = pattern.replaceAll('\\', '/')
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(pattern) ||
    PARENT_SEGMENT_PATTERN.test(normalized) ||
    (normalized.startsWith('!') && !normalized.startsWith('!('))
  ) {
    throw new WorkspaceGlobError(
      'Glob pattern must be one positive path relative to the requested directory',
    )
  }

  const relative = normalized.replace(/^\.\/+/, '')
  if (!relative) {
    throw new WorkspaceGlobError('Glob pattern must not be empty')
  }
  return relative
}

function options(cwd: string, baseNameMatch: boolean): fastGlob.Options {
  return {
    absolute: false,
    baseNameMatch,
    braceExpansion: true,
    caseSensitiveMatch: true,
    concurrency: 16,
    cwd,
    dot: true,
    extglob: true,
    followSymbolicLinks: false,
    globstar: true,
    ignore: IGNORED_DIRECTORY_GLOBS,
    objectMode: true,
    onlyDirectories: false,
    onlyFiles: true,
    suppressErrors: false,
    throwErrorOnBrokenSymbolicLink: false,
    unique: true,
  }
}

function validateTaskRoots(
  guard: PathGuard,
  root: string,
  pattern: string,
  globOptions: fastGlob.Options,
): void {
  let tasks: fastGlob.Task[]
  try {
    tasks = fastGlob.generateTasks(pattern, globOptions)
  } catch (error) {
    throw new WorkspaceGlobError(
      error instanceof Error ? error.message : 'Glob pattern is invalid',
    )
  }

  if (tasks.length === 0) {
    throw new WorkspaceGlobError('Glob pattern must include a positive match')
  }

  for (const task of tasks) {
    const taskRoot = path.resolve(root, task.base)
    if (!isInsideRoot(root, taskRoot)) {
      throw new WorkspaceGlobError(
        'Glob pattern cannot traverse outside the requested directory',
      )
    }
    guard.resolveCandidate(taskRoot)
  }
}

/** Iterates guarded workspace-relative files that match one directory-relative glob. */
export async function* iterateWorkspaceGlobFiles(
  input: WorkspaceGlobInput,
): AsyncGenerator<string> {
  const root = await input.guard.resolveExisting(input.rootInput)
  const rootStats = await stat(root.realPath)
  if (!rootStats.isDirectory()) {
    throw new PathGuardError('NOT_A_DIRECTORY', 'Path is not a directory')
  }

  const pattern = normalizePattern(input.pattern)
  const globOptions = options(root.realPath, input.baseNameMatch === true)
  validateTaskRoots(input.guard, root.realPath, pattern, globOptions)

  if (input.signal.aborted) {
    throw abortError(input.signal)
  }

  const stream = fastGlob.stream(pattern, globOptions) as Readable &
    AsyncIterable<fastGlob.Entry>
  const abort = () => stream.destroy(abortError(input.signal))
  input.signal.addEventListener('abort', abort, { once: true })

  try {
    for await (const entry of stream) {
      if (entry.dirent.isSymbolicLink() || !entry.dirent.isFile()) {
        continue
      }

      const relativeToRoot = normalizePortablePath(entry.path)
      const workspaceRelative =
        root.relativePath === '.'
          ? relativeToRoot
          : `${normalizePortablePath(root.relativePath)}/${relativeToRoot}`
      const guarded = await input.guard.resolveExisting(workspaceRelative)
      yield guarded.relativePath
    }
  } finally {
    input.signal.removeEventListener('abort', abort)
    stream.destroy()
  }
}
