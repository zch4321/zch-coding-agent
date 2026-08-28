import { open, readdir, realpath, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export type PathGuardErrorCode =
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'PATH_ALREADY_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'RESOURCE_CHANGED'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'

/** Reports traversal, symlink, canonical-path, and bounded-read violations. */
export class PathGuardError extends Error {
  readonly code: PathGuardErrorCode

  constructor(code: PathGuardErrorCode, message: string) {
    super(message)
    this.name = 'PathGuardError'
    this.code = code
  }
}

export interface GuardedPath {
  readonly inputPath: string
  readonly absolutePath: string
  readonly realPath: string
  readonly rootKind: PathGuardRootKind
  readonly rootPath: string
  readonly rootRelativePath: string
  readonly relativePath: string
}

export type PathGuardRootKind = 'workspace' | 'session-temp'

interface PathGuardRoot {
  readonly kind: PathGuardRootKind
  readonly canonicalPath: string
  readonly aliases: readonly string[]
}

export interface DirectoryEntry {
  readonly path: string
  readonly name: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
}

const textDecoder = new TextDecoder('utf-8', { fatal: false })

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSubpath(base: string, candidate: string): boolean {
  const normalizedBase = normalizeForCompare(base)
  const normalizedCandidate = normalizeForCompare(candidate)

  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`)
  )
}

function toPortableRelative(value: string): string {
  return value.split(path.sep).join('/')
}

function assertReasonableInput(inputPath: string): void {
  if (!inputPath || inputPath.includes('\0')) {
    throw new PathGuardError('INVALID_PATH', 'Path must be a non-empty string')
  }
}

async function nearestExistingParent(target: string): Promise<string> {
  let current = target

  while (true) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    }

    const parent = path.dirname(current)

    if (parent === current) {
      throw new PathGuardError('PATH_NOT_FOUND', 'No existing parent found')
    }

    current = parent
  }
}

/** Guards workspace and Session-temp paths against traversal and symlink escapes. */
export class PathGuard {
  readonly workspacePath: string
  readonly sessionTempPath?: string
  readonly #roots: readonly PathGuardRoot[]

  private constructor(workspace: PathGuardRoot, sessionTemp?: PathGuardRoot) {
    this.workspacePath = workspace.canonicalPath
    this.sessionTempPath = sessionTemp?.canonicalPath
    this.#roots = sessionTemp ? [workspace, sessionTemp] : [workspace]
  }

  /** Creates a guard for an already canonical workspace path and its accepted aliases. */
  static fromCanonical(
    workspacePath: string,
    sessionTempPath?: string,
  ): PathGuard {
    assertReasonableInput(workspacePath)
    const workspace = PathGuard.#canonicalRoot('workspace', workspacePath)
    const sessionTemp = sessionTempPath
      ? PathGuard.#canonicalRoot('session-temp', sessionTempPath)
      : undefined
    return new PathGuard(workspace, sessionTemp)
  }

  /** Realpaths the workspace and creates a guard with its canonical alias roots. */
  static async create(
    workspacePath: string,
    sessionTempPath?: string,
  ): Promise<PathGuard> {
    assertReasonableInput(workspacePath)
    const workspace = await PathGuard.#realRoot('workspace', workspacePath)
    const sessionTemp = sessionTempPath
      ? await PathGuard.#realRoot('session-temp', sessionTempPath)
      : undefined
    return new PathGuard(workspace, sessionTemp)
  }

  static #canonicalRoot(
    kind: PathGuardRootKind,
    inputPath: string,
  ): PathGuardRoot {
    assertReasonableInput(inputPath)
    const resolvedPath = path.resolve(inputPath)
    try {
      const canonicalPath = path.resolve(realpathSync.native(resolvedPath))
      return {
        kind,
        canonicalPath,
        aliases: [...new Set([canonicalPath, resolvedPath])],
      }
    } catch {
      return { kind, canonicalPath: resolvedPath, aliases: [resolvedPath] }
    }
  }

  static async #realRoot(
    kind: PathGuardRootKind,
    inputPath: string,
  ): Promise<PathGuardRoot> {
    assertReasonableInput(inputPath)
    const resolvedPath = path.resolve(inputPath)
    const canonicalPath = path.resolve(await realpath(resolvedPath))
    const rootStat = await stat(canonicalPath)
    if (!rootStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        `${kind === 'workspace' ? 'Workspace' : 'Session temp'} must be a directory`,
      )
    }
    return {
      kind,
      canonicalPath,
      aliases: [...new Set([canonicalPath, resolvedPath])],
    }
  }

  #rootForCandidate(candidate: string): PathGuardRoot | undefined {
    return this.#roots
      .flatMap((root) =>
        root.aliases.map((alias) => ({ root, alias: path.resolve(alias) })),
      )
      .filter(({ alias }) => isSubpath(alias, candidate))
      .sort((left, right) => right.alias.length - left.alias.length)[0]?.root
  }

  #rootForRealPath(candidate: string): PathGuardRoot | undefined {
    return this.#roots
      .filter((root) => isSubpath(root.canonicalPath, candidate))
      .sort(
        (left, right) => right.canonicalPath.length - left.canonicalPath.length,
      )[0]
  }

  #candidate(inputPath: string): { absolutePath: string; root: PathGuardRoot } {
    assertReasonableInput(inputPath)
    const absolutePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.workspacePath, inputPath)
    const root = this.#rootForCandidate(absolutePath)

    if (!root) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Path escapes the workspace and Session temp roots',
      )
    }
    return { absolutePath, root }
  }

  /** Resolves a relative or absolute candidate under the workspace without filesystem access. */
  resolveCandidate(inputPath: string): string {
    return this.#candidate(inputPath).absolutePath
  }

  /** Resolves an existing path and checks real parent containment to block symlink escapes. */
  async resolveExisting(inputPath: string): Promise<GuardedPath> {
    const { absolutePath, root } = this.#candidate(inputPath)
    const parent = await nearestExistingParent(absolutePath)
    const parentRealPath = await realpath(parent)

    if (!isSubpath(root.canonicalPath, parentRealPath)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Existing parent escapes its allowed root',
      )
    }

    let realPathValue: string

    try {
      realPathValue = await realpath(absolutePath)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new PathGuardError('PATH_NOT_FOUND', 'Path does not exist')
      }

      throw error
    }

    if (!isSubpath(root.canonicalPath, realPathValue)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Real path escapes its allowed root',
      )
    }

    const rootRelativePath = toPortableRelative(
      path.relative(root.canonicalPath, realPathValue) || '.',
    )

    return {
      inputPath,
      absolutePath,
      realPath: path.resolve(realPathValue),
      rootKind: root.kind,
      rootPath: root.canonicalPath,
      rootRelativePath,
      relativePath:
        root.kind === 'workspace'
          ? rootRelativePath
          : path.resolve(realPathValue),
    }
  }

  /** Ensures a real path remains inside either allowed root. */
  assertInside(realPathValue: string): void {
    if (!this.#rootForRealPath(realPathValue)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Real path escapes the workspace and Session temp roots',
      )
    }
  }

  /** Resolves which allowed root owns a lexical path. */
  rootForCandidate(inputPath: string): {
    kind: PathGuardRootKind
    path: string
  } {
    const { root } = this.#candidate(inputPath)
    return { kind: root.kind, path: root.canonicalPath }
  }

  /** Ensures a real path remains inside one specific allowed root. */
  assertInsideRoot(realPathValue: string, kind: PathGuardRootKind): void {
    const root = this.#roots.find((candidate) => candidate.kind === kind)
    if (!root || !isSubpath(root.canonicalPath, realPathValue)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        `Real path escapes the ${kind} root`,
      )
    }
  }

  /** Reads a guarded file while enforcing byte and abort limits. */
  async readFileBounded(
    inputPath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    path: string
    content: string
    totalBytes: number
    truncated: boolean
  }> {
    const guarded = await this.resolveExisting(inputPath)
    const handle = await open(guarded.realPath, 'r')

    try {
      const fileStat = await handle.stat()

      if (!fileStat.isFile()) {
        throw new PathGuardError('NOT_A_FILE', 'Path is not a regular file')
      }

      if (signal?.aborted) {
        throw signal.reason
      }

      const bytesToRead = Math.min(fileStat.size, maxBytes + 1)
      const buffer = Buffer.alloc(bytesToRead)
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
      const postOpenRealPath = await realpath(guarded.absolutePath)

      if (
        normalizeForCompare(postOpenRealPath) !==
        normalizeForCompare(guarded.realPath)
      ) {
        throw new PathGuardError(
          'RESOURCE_CHANGED',
          'Path changed while it was being read',
        )
      }

      const truncated = bytesRead > maxBytes
      const contentBuffer = truncated
        ? buffer.subarray(0, maxBytes)
        : buffer.subarray(0, bytesRead)

      return {
        path: guarded.relativePath,
        content: textDecoder.decode(contentBuffer),
        totalBytes: fileStat.size,
        truncated,
      }
    } finally {
      await handle.close()
    }
  }

  /** Lists entries in a guarded directory after validating its real path. */
  async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    const guarded = await this.resolveExisting(inputPath)
    const directoryStat = await stat(guarded.realPath)

    if (!directoryStat.isDirectory()) {
      throw new PathGuardError('NOT_A_DIRECTORY', 'Path is not a directory')
    }

    const entries = await readdir(guarded.realPath, { withFileTypes: true })

    return entries.map((entry) => {
      const entryRelative =
        guarded.rootKind === 'workspace'
          ? toPortableRelative(
              path.join(
                guarded.relativePath === '.' ? '' : guarded.relativePath,
                entry.name,
              ),
            )
          : path.join(guarded.realPath, entry.name)
      const type = entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other'

      return {
        path: entryRelative,
        name: entry.name,
        type,
      }
    })
  }
}
