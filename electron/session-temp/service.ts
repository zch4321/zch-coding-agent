import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SessionId } from '../../shared/ids'

const SESSION_TEMP_VERSION = 1
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000

export interface SessionTempPaths {
  root: string
  artifacts: string
  scratch: string
}

export interface SessionTempServiceOptions {
  rootDirectory: string
  retentionMs?: number
  now?: () => number
  onDiagnostic?: (message: string, error?: unknown) => void
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Returns an app-profile-specific Desktop temp root outside every workspace. */
export function desktopSessionTempRoot(runtimeDataDirectory: string): string {
  return path.join(
    os.tmpdir(),
    'zch-coding-agent',
    sha256(path.resolve(runtimeDataDirectory)).slice(0, 24),
  )
}

/** Produces a portable filename that still exposes a recognizable source ID. */
export function sessionArtifactKey(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80)
  return `${normalized || 'item'}-${sha256(value).slice(0, 10)}`
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

/** Refreshes the retention timestamp for one exact Session temp root. */
export async function touchSessionTempPath(
  sessionTemp: SessionTempPaths,
): Promise<void> {
  const now = new Date()
  await utimes(sessionTemp.root, now, now)
}

function assertSegment(segment: string): void {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error('Session artifact path segment is invalid')
  }
}

/** Atomically writes an application-owned artifact beneath one Session temp root. */
export async function writeSessionArtifactText(
  sessionTemp: SessionTempPaths,
  segments: readonly string[],
  content: string,
): Promise<string> {
  segments.forEach(assertSegment)
  const filePath = path.join(sessionTemp.artifacts, ...segments)
  await ensurePrivateDirectory(path.dirname(filePath))
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, filePath)
    await touchSessionTempPath(sessionTemp)
    return filePath
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/** Atomically writes deterministic pretty JSON beneath one Session artifact directory. */
export function writeSessionArtifactJson(
  sessionTemp: SessionTempPaths,
  segments: readonly string[],
  value: unknown,
): Promise<string> {
  return writeSessionArtifactText(
    sessionTemp,
    segments,
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

/** Owns deterministic per-Session temp directories and bounded path creation. */
export class SessionTempService {
  readonly #rootDirectory: string
  readonly #retentionMs: number
  readonly #now: () => number
  readonly #onDiagnostic: (message: string, error?: unknown) => void

  constructor(options: SessionTempServiceOptions) {
    this.#rootDirectory = path.resolve(options.rootDirectory)
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.#now = options.now ?? Date.now
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Creates the profile root and removes inactive Session directories older than retention. */
  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#rootDirectory)
    const entries = await readdir(this.#rootDirectory, {
      withFileTypes: true,
    }).catch(() => [])
    const cutoff = this.#now() - this.#retentionMs
    for (const entry of entries) {
      const candidate = path.join(this.#rootDirectory, entry.name)
      try {
        const metadata = await lstat(candidate)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue
        if (metadata.mtimeMs >= cutoff) continue
        await rm(candidate, { recursive: true, force: true })
      } catch (error) {
        this.#onDiagnostic(
          'Failed to clean an expired Session temp directory',
          error,
        )
      }
    }
  }

  /** Returns deterministic paths without creating them. */
  pathsFor(sessionId: SessionId): SessionTempPaths {
    const root = path.join(this.#rootDirectory, sha256(sessionId))
    return {
      root,
      artifacts: path.join(root, 'artifacts'),
      scratch: path.join(root, 'scratch'),
    }
  }

  /** Creates and touches the directory shared by one public Session and its children. */
  async ensureSession(sessionId: SessionId): Promise<SessionTempPaths> {
    const paths = this.pathsFor(sessionId)
    await Promise.all([
      ensurePrivateDirectory(paths.artifacts),
      ensurePrivateDirectory(paths.scratch),
    ])
    await this.#writeOwner(paths.root, sessionId)
    await this.touch(sessionId)
    return paths
  }

  /** Updates the Session directory age used by startup retention cleanup. */
  async touch(sessionId: SessionId): Promise<void> {
    const { root } = this.pathsFor(sessionId)
    const now = new Date(this.#now())
    await utimes(root, now, now).catch(() => undefined)
  }

  /** Permanently removes one exact Session directory. */
  async removeSession(sessionId: SessionId): Promise<void> {
    await rm(this.pathsFor(sessionId).root, { recursive: true, force: true })
  }

  /** Resolves an application-owned artifact path and creates its parent directory. */
  async artifactPath(
    sessionId: SessionId,
    ...segments: string[]
  ): Promise<string> {
    segments.forEach(assertSegment)
    const paths = await this.ensureSession(sessionId)
    const target = path.join(paths.artifacts, ...segments)
    await ensurePrivateDirectory(path.dirname(target))
    return target
  }

  /** Opens an append-only artifact file with owner-only permissions. */
  async openAppend(
    sessionId: SessionId,
    ...segments: string[]
  ): Promise<{ path: string; file: FileHandle }> {
    const filePath = await this.artifactPath(sessionId, ...segments)
    const file = await open(filePath, 'a', 0o600)
    if (process.platform !== 'win32') await file.chmod(0o600)
    return { path: filePath, file }
  }

  /** Atomically writes one UTF-8 artifact file. */
  async writeText(
    sessionId: SessionId,
    segments: string[],
    content: string,
  ): Promise<string> {
    const paths = await this.ensureSession(sessionId)
    return writeSessionArtifactText(paths, segments, content)
  }

  /** Atomically writes deterministic pretty JSON for model inspection. */
  async writeJson(
    sessionId: SessionId,
    segments: string[],
    value: unknown,
  ): Promise<string> {
    return this.writeText(
      sessionId,
      segments,
      `${JSON.stringify(value, null, 2)}\n`,
    )
  }

  async #writeOwner(root: string, sessionId: SessionId): Promise<void> {
    const marker = path.join(root, '.session-temp.json')
    try {
      await stat(marker)
    } catch {
      await writeFile(
        marker,
        `${JSON.stringify({
          schemaVersion: SESSION_TEMP_VERSION,
          sessionHash: sha256(sessionId),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
  }
}
