import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type PathGuardErrorCode =
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'RESOURCE_CHANGED'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'

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
  readonly relativePath: string
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

export class PathGuard {
  readonly workspacePath: string

  private constructor(workspacePath: string) {
    this.workspacePath = workspacePath
  }

  static fromCanonical(workspacePath: string): PathGuard {
    return new PathGuard(path.resolve(workspacePath))
  }

  static async create(workspacePath: string): Promise<PathGuard> {
    assertReasonableInput(workspacePath)
    const workspaceRealPath = await realpath(workspacePath)
    const workspaceStat = await stat(workspaceRealPath)

    if (!workspaceStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        'Workspace must be a directory',
      )
    }

    return new PathGuard(path.resolve(workspaceRealPath))
  }

  resolveCandidate(inputPath: string): string {
    assertReasonableInput(inputPath)
    const absolutePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.workspacePath, inputPath)

    if (!isSubpath(this.workspacePath, absolutePath)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Path escapes the workspace',
      )
    }

    return absolutePath
  }

  async resolveExisting(inputPath: string): Promise<GuardedPath> {
    const absolutePath = this.resolveCandidate(inputPath)
    const parent = await nearestExistingParent(absolutePath)
    const parentRealPath = await realpath(parent)

    if (!isSubpath(this.workspacePath, parentRealPath)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Existing parent escapes the workspace',
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

    if (!isSubpath(this.workspacePath, realPathValue)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Real path escapes the workspace',
      )
    }

    return {
      inputPath,
      absolutePath,
      realPath: path.resolve(realPathValue),
      relativePath: toPortableRelative(
        path.relative(this.workspacePath, realPathValue) || '.',
      ),
    }
  }

  assertInside(realPathValue: string): void {
    if (!isSubpath(this.workspacePath, realPathValue)) {
      throw new PathGuardError(
        'PATH_OUTSIDE_WORKSPACE',
        'Real path escapes the workspace',
      )
    }
  }

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

  async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    const guarded = await this.resolveExisting(inputPath)
    const directoryStat = await stat(guarded.realPath)

    if (!directoryStat.isDirectory()) {
      throw new PathGuardError('NOT_A_DIRECTORY', 'Path is not a directory')
    }

    const entries = await readdir(guarded.realPath, { withFileTypes: true })

    return entries.map((entry) => {
      const entryRelative = toPortableRelative(
        path.join(
          guarded.relativePath === '.' ? '' : guarded.relativePath,
          entry.name,
        ),
      )
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
