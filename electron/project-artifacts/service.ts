import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalPath,
  createSymbolicLink,
  linkStatus,
  readDirectory,
  readFileContents,
  readSymbolicLink,
  removePath,
  unlinkFile,
  writeFileContents,
} from '../common/filesystem'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { DatabaseService } from '../persistence/database-service'
import { ProjectArtifactRepository } from '../persistence/project-artifact-repository'
import {
  SessionTempService,
  desktopSessionTempRoot,
  type SessionTempPaths,
} from '../session-temp/service'
import { artifactSegments } from './access'
import { copyLegacyCapture } from './legacy-copy'
import { writeJsonAtomic } from '../config/atomic-file'
import { migrateLegacyArtifacts, removeLegacyCapture } from './legacy'
import {
  prepareArtifactPath,
  privateArtifactDirectory,
  sameNativePath,
} from './native-paths'

const RETENTION_MS = 24 * 60 * 60_000

/** Chooses a short, profile-specific native directory without exposing Session hashes. */
export function projectArtifactRoot(profile: string): string {
  const digest = createHash('sha256')
    .update(path.resolve(profile))
    .digest('hex')
    .slice(0, 16)
  return path.join(
    process.platform === 'darwin' ? '/tmp' : os.tmpdir(),
    `zch-${digest}`,
  )
}

/** Owns project-scoped native roots and durable output captures for both application hosts. */
export class ProjectArtifactService extends SessionTempService {
  readonly #database: DatabaseService
  readonly #repository = new ProjectArtifactRepository()
  readonly #base: string
  readonly #legacy: SessionTempService
  readonly #instance = randomUUID()
  readonly #now: () => number
  readonly #diagnostic: (message: string, error?: unknown) => void
  readonly #sessions = new Map<SessionId, SessionTempPaths>()
  readonly #projects = new Map<
    string,
    { root: string; tmp: string; workspace: string }
  >()
  readonly #pending = new Map<
    string,
    Promise<{ root: string; tmp: string; workspace: string }>
  >()
  #timer?: ReturnType<typeof setInterval>
  #collecting?: Promise<void>

  constructor(options: {
    database: DatabaseService
    profileDirectory: string
    legacyProfileDirectory?: string
    rootDirectory?: string
    now?: () => number
    onDiagnostic?: (message: string, error?: unknown) => void
  }) {
    const legacyRoot = desktopSessionTempRoot(
      options.legacyProfileDirectory ?? options.profileDirectory,
    )
    super({ rootDirectory: legacyRoot })
    this.#database = options.database
    this.#base =
      options.rootDirectory ?? projectArtifactRoot(options.profileDirectory)
    this.#legacy = new SessionTempService({ rootDirectory: legacyRoot })
    this.#now = options.now ?? Date.now
    this.#diagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Recovers abandoned captures only after the common backend has claimed profile ownership. */
  override async initialize(): Promise<void> {
    await privateArtifactDirectory(this.#base)
    await this.#database.withTransaction((transaction) =>
      this.#repository.recover(transaction, this.#now()),
    )
    await this.collect()
    this.#timer = setInterval(() => {
      void this.collect().catch((error) =>
        this.#diagnostic('Project artifact cleanup failed', error),
      )
    }, 60_000)
    this.#timer.unref()
  }

  /** Returns the current owner's shared project paths, or its exact legacy view before hydration. */
  override pathsFor(sessionId: SessionId): SessionTempPaths {
    return this.#sessions.get(sessionId) ?? this.#legacy.pathsFor(sessionId)
  }

  /** Hydrates a native project root while keeping producer provenance scoped to the originating Session. */
  override async ensureSession(
    sessionId: SessionId,
    project?: {
      projectId: ProjectId
      workspace: string
      sourceSessionId?: SessionId
    },
  ): Promise<SessionTempPaths> {
    if (!project) {
      const row = this.#database.read((reader) =>
        reader
          .prepare(
            'SELECT project_id AS projectId, parent_session_id AS parentId FROM sessions WHERE id = ?',
          )
          .get(sessionId),
      )
      if (!row)
        throw new Error('A persistent project is required for artifact storage')
      const owner = this.#database.read((reader) =>
        reader
          .prepare('SELECT path FROM projects WHERE id = ?')
          .get(String(row.projectId)),
      )
      if (!owner) throw new Error('Artifact project was removed')
      project = {
        projectId: String(row.projectId) as ProjectId,
        workspace: String(owner.path),
        ...(row.parentId
          ? { sourceSessionId: String(row.parentId) as SessionId }
          : {}),
      }
    }
    const { projectId } = project
    const root = await this.#ensureProject(projectId, project.workspace)
    const legacySources = [this.#legacy.pathsFor(sessionId)]
    const visited = new Set<string>([sessionId])
    let ancestor = project.sourceSessionId
    while (ancestor && !visited.has(ancestor) && visited.size < 128) {
      visited.add(ancestor)
      const row = this.#database.read((reader) =>
        reader
          .prepare(
            'SELECT parent_session_id AS parentId FROM sessions WHERE id = ? AND project_id = ?',
          )
          .get(ancestor!, projectId),
      )
      if (!row) break
      legacySources.push(this.#legacy.pathsFor(ancestor))
      ancestor = row.parentId ? (String(row.parentId) as SessionId) : undefined
    }
    let legacy: SessionTempPaths | undefined
    for (const source of legacySources) {
      const info = await linkStatus(source.root).catch(() => undefined)
      if (info?.isDirectory() && !info.isSymbolicLink()) {
        legacy = source
        break
      }
    }
    const mappings = () =>
      this.#database.read((reader) =>
        this.#repository.legacy(reader, projectId),
      )
    const keyFor = (kind: string, sourceKey: string) =>
      kind === 'terminals' ? `${this.#instance}:${sourceKey}` : sourceKey
    const paths: SessionTempPaths = {
      projectId,
      canonicalRoot: await canonicalPath(root.tmp),
      root: root.tmp,
      artifacts: path.join(root.tmp, 'artifacts'),
      scratch: path.join(root.tmp, 'scratch'),
      workspaceAlias: path.join(root.root, 'workspace'),
      legacy,
      artifactAccess: {
        available: (segments) => {
          const { kind, sourceKey } = artifactSegments(segments)
          const record = this.#database.read((reader) =>
            this.#repository.find(
              reader,
              projectId,
              kind,
              sessionId,
              keyFor(kind, sourceKey),
            ),
          )
          return Boolean(
            record && record.status !== 'expired' && record.status !== 'failed',
          )
        },
        path: async (segments, create) => {
          const { kind, sourceKey, suffix } = artifactSegments(segments)
          const key = keyFor(kind, sourceKey)
          const record = create
            ? await this.#database.withTransaction((transaction) =>
                this.#repository.allocate(transaction, {
                  projectId,
                  kind,
                  ownerSessionId: sessionId,
                  sourceKey: key,
                  now: this.#now(),
                }),
              )
            : this.#database.read((reader) =>
                this.#repository.find(reader, projectId, kind, sessionId, key),
              )
          if (!record) return path.join(root.tmp, 'artifacts', ...segments)
          if (create && record.status === 'expired')
            throw new Error(
              'ARTIFACT_EXPIRED: this capture has already expired',
            )
          const target = path.join(root.tmp, record.relativePath, ...suffix)
          if (create) {
            await this.#verifyRoot(root.root, projectId)
            await prepareArtifactPath(root.tmp, target)
          }
          return target
        },
        finish: async (segments, error) => {
          const { kind, sourceKey } = artifactSegments(segments)
          await this.#database.withTransaction((transaction) => {
            const record = this.#repository.find(
              transaction,
              projectId,
              kind,
              sessionId,
              keyFor(kind, sourceKey),
            )
            if (record)
              this.#repository.finish(transaction, record, this.#now(), error)
          })
        },
        validate: async (candidate) => {
          await this.#verifyRoot(root.root, projectId)
          await prepareArtifactPath(root.tmp, candidate)
        },
        resolveAlias: (aliasRoot, suffix) => {
          const candidates = legacySources.map((source) =>
            path.resolve(source[aliasRoot], suffix),
          )
          const exact = candidates.flatMap((candidate) =>
            mappings()
              .filter(
                (mapping) =>
                  mapping.oldPath === candidate ||
                  candidate.startsWith(`${mapping.oldPath}${path.sep}`),
              )
              .filter(
                (mapping) =>
                  mapping.relativePath !== '' &&
                  mapping.relativePath !== 'artifacts',
              )
              .slice(0, 1)
              .map((mapping) => {
                if (mapping.state === 'pending')
                  throw new Error(
                    'LEGACY_MIGRATION_PENDING: this output migration is incomplete',
                  )
                return path.join(
                  root.tmp,
                  mapping.relativePath,
                  path.relative(mapping.oldPath, candidate),
                )
              }),
          )
          const unique = [...new Set(exact)]
          if (unique.length > 1)
            throw new Error(
              `AMBIGUOUS_LEGACY_PATH: use an explicit native project artifact path: ${unique.join(', ')}`,
            )
          return (
            unique[0] ?? paths.artifactAccess!.resolveLegacy(candidates[0]!)
          )
        },
        resolveLegacy: (candidate) => {
          if (!path.isAbsolute(candidate)) return candidate
          const absolute = path.resolve(candidate)
          for (const mapping of mappings()) {
            const relative = path.relative(mapping.oldPath, absolute)
            if (
              relative === '' ||
              (!relative.startsWith(`..${path.sep}`) &&
                relative !== '..' &&
                !path.isAbsolute(relative))
            ) {
              if (mapping.state === 'pending')
                throw new Error(
                  'LEGACY_MIGRATION_PENDING: this output migration is incomplete',
                )
              return path.join(root.tmp, mapping.relativePath, relative)
            }
          }
          return candidate
        },
      },
    }
    this.#sessions.set(sessionId, paths)
    return paths
  }

  async #ensureProject(
    projectId: string,
    workspace: string,
  ): Promise<{ root: string; tmp: string; workspace: string }> {
    const existing = this.#projects.get(projectId)
    if (existing?.workspace === workspace) {
      await this.#verifyRoot(existing.root, projectId)
      await privateArtifactDirectory(existing.tmp)
      await privateArtifactDirectory(path.join(existing.tmp, 'artifacts'))
      await privateArtifactDirectory(path.join(existing.tmp, 'scratch'))
      const link = path.join(existing.root, 'workspace')
      if (
        !(await linkStatus(link)).isSymbolicLink() ||
        !sameNativePath(await canonicalPath(link), workspace)
      )
        throw new Error('Workspace short entry target was replaced')
      return existing
    }
    const pending = this.#pending.get(projectId)
    if (pending) return pending
    const creating = this.#createProject(projectId, workspace)
    this.#pending.set(projectId, creating)
    try {
      return await creating
    } finally {
      this.#pending.delete(projectId)
    }
  }

  async #createProject(
    projectId: string,
    workspace: string,
  ): Promise<{ root: string; tmp: string; workspace: string }> {
    const canonical = await canonicalPath(workspace)
    await privateArtifactDirectory(this.#base)
    const record = await this.#database.withTransaction((transaction) =>
      this.#repository.ensureRoot(transaction, projectId, canonical),
    )
    const root = path.join(this.#base, String(record.id))
    await privateArtifactDirectory(root)
    const markerPath = path.join(root, '.project-owner.json')
    try {
      const marker = JSON.parse(await readFileContents(markerPath, 'utf8'))
      if (marker.projectId !== projectId || marker.rootId !== record.id)
        throw new Error('Project short root ownership mismatch')
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error
      if ((await readDirectory(root)).length > 0)
        throw new Error('Project short root contains unowned files', {
          cause: error,
        })
      await writeFileContents(
        markerPath,
        JSON.stringify({ projectId, rootId: record.id }),
        { flag: 'wx', mode: 0o600 },
      )
    }
    const link = path.join(root, 'workspace')
    const info = await linkStatus(link).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined
      throw error
    })
    if (info) {
      if (!info.isSymbolicLink())
        throw new Error('Workspace short entry was replaced by a regular path')
      const target = path.resolve(
        path.dirname(link),
        await readSymbolicLink(link),
      )
      if (!sameNativePath(target, canonical)) {
        if (!sameNativePath(target, record.workspace))
          throw new Error('Workspace short entry target was replaced')
        await unlinkFile(link)
        await createSymbolicLink(
          canonical,
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      }
    } else
      await createSymbolicLink(
        canonical,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    const tmp = path.join(root, 'tmp')
    await privateArtifactDirectory(tmp)
    await privateArtifactDirectory(path.join(tmp, 'artifacts'))
    await privateArtifactDirectory(path.join(tmp, 'scratch'))
    await this.#database.withTransaction((transaction) =>
      this.#repository.bindRoot(transaction, projectId, canonical),
    )
    await migrateLegacyArtifacts({
      database: this.#database,
      repository: this.#repository,
      projectId,
      tmp,
      legacy: this.#legacy,
      now: this.#now,
      onDiagnostic: this.#diagnostic,
    })
    const result = { root, tmp, workspace: canonical }
    this.#projects.set(projectId, result)
    return result
  }

  /** Keeps Session touches independent of sealed artifact retention deadlines. */
  override async touch(_sessionId: SessionId): Promise<void> {
    void _sessionId
  }

  /** Drops only the Session view; shared project files retain their own lifecycle. */
  override async removeSession(sessionId: SessionId): Promise<void> {
    this.#sessions.delete(sessionId)
  }

  /** Removes only a verified project runtime directory after its tasks have quiesced. */
  async removeProject(projectId: string): Promise<void> {
    const record = this.#database.read((reader) =>
      this.#repository.root(reader, projectId),
    )
    if (!record) return
    const root = path.join(this.#base, String(record.id))
    const info = await linkStatus(root).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined
      throw error
    })
    if (info) {
      await this.#verifyRoot(root, projectId)
      await removePath(root, { recursive: true, force: true })
    }
    const mappings = this.#database.read((reader) =>
      this.#repository.legacy(reader, projectId),
    )
    for (const mapping of mappings.filter(
      (entry) => entry.relativePath && entry.relativePath !== 'artifacts',
    ))
      await removeLegacyCapture(this.#legacy, mapping)
    this.#projects.delete(projectId)
    for (const [id, session] of this.#sessions)
      if (session.projectId === projectId) this.#sessions.delete(id)
    await this.#database.withTransaction((transaction) => {
      transaction
        .prepare(
          'DELETE FROM project_artifact_legacy_paths WHERE project_id = ?',
        )
        .run(projectId)
      transaction
        .prepare('DELETE FROM project_artifacts WHERE project_id = ?')
        .run(projectId)
      transaction
        .prepare('DELETE FROM project_artifact_sequences WHERE project_id = ?')
        .run(projectId)
      transaction
        .prepare('DELETE FROM project_runtime_roots WHERE project_id = ?')
        .run(projectId)
    })
  }

  async #verifyRoot(root: string, projectId: string): Promise<void> {
    const base = await linkStatus(this.#base)
    if (!base.isDirectory() || base.isSymbolicLink())
      throw new Error('Project base was replaced')
    const info = await linkStatus(root)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Project cleanup root was replaced')
    const owner = JSON.parse(
      await readFileContents(path.join(root, '.project-owner.json'), 'utf8'),
    )
    if (owner.projectId !== projectId)
      throw new Error('Project cleanup ownership mismatch')
  }

  /** Collects sealed captures by their own finalization time; active captures never enter the query. */
  collect(): Promise<void> {
    if (this.#collecting) return this.#collecting
    this.#collecting = this.#collect().finally(() => {
      this.#collecting = undefined
    })
    return this.#collecting
  }

  async #collect(): Promise<void> {
    const orphans = this.#database.read((reader) =>
      reader
        .prepare(
          'SELECT project_id AS projectId FROM project_runtime_roots WHERE project_id NOT IN (SELECT id FROM projects)',
        )
        .all(),
    )
    for (const orphan of orphans) {
      try {
        await this.removeProject(String(orphan.projectId))
      } catch (error) {
        this.#diagnostic('Could not clean a removed project root', error)
      }
    }
    const records = this.#database.read((reader) =>
      this.#repository.expired(reader, this.#now() - RETENTION_MS),
    )
    for (const record of records) {
      try {
        const project = this.#database.read((reader) =>
          this.#repository.root(reader, record.projectId),
        )
        if (!project) continue
        const root = path.join(this.#base, String(project.id))
        const info = await linkStatus(root).catch(() => undefined)
        if (info) {
          await this.#verifyRoot(root, record.projectId)
          const tmp = path.join(root, 'tmp')
          const tmpInfo = await linkStatus(tmp)
          if (!tmpInfo.isDirectory() || tmpInfo.isSymbolicLink())
            throw new Error('Artifact cleanup tmp root was replaced')
          const target = path.resolve(tmp, record.relativePath)
          if (!target.startsWith(`${tmp}${path.sep}`))
            throw new Error('Invalid registered artifact path')
          // Validate ancestors; removePath must never traverse a replaced artifact-category link.
          const parent = await canonicalPath(path.dirname(target)).catch(
            () => undefined,
          )
          const canonicalTmp = await canonicalPath(tmp)
          if (parent && !parent.startsWith(`${canonicalTmp}${path.sep}`))
            throw new Error('Artifact cleanup parent escaped its root')
          await removePath(target, { recursive: true, force: true })
        }
        const mappings = this.#database.read((reader) =>
          this.#repository.legacy(reader, record.projectId),
        )
        for (const mapping of mappings.filter(
          (entry) => entry.relativePath === record.relativePath,
        ))
          await removeLegacyCapture(this.#legacy, mapping)
        await this.#database.withTransaction((transaction) =>
          this.#repository.markExpired(transaction, record),
        )
      } catch (error) {
        this.#diagnostic('Could not collect an expired project artifact', error)
      }
    }
  }

  /** Exports only this task's finalized captures, with per-file availability and durable native references. */
  async exportSession(
    sessionId: SessionId,
    destination: string,
  ): Promise<string> {
    const paths = await this.ensureSession(sessionId)
    const records = this.#database.read((reader) =>
      this.#repository.owned(reader, paths.projectId!, sessionId),
    )
    const captures = []
    for (const record of records) {
      const target = path.join(destination, record.relativePath)
      const nativePath = path.join(paths.root, record.relativePath)
      let error: string | undefined
      try {
        if (record.status === 'active' || record.status === 'expired')
          throw new Error(`Capture is ${record.status}`)
        await copyLegacyCapture(destination, nativePath, target)
      } catch (failure) {
        error = String(failure)
      }
      captures.push({
        projectId: record.projectId,
        kind: record.kind,
        id: record.id,
        status: record.status,
        nativePath,
        ...(error
          ? { available: false, error }
          : { available: true, exportedPath: target }),
      })
    }
    const index = path.join(destination, 'artifacts.json')
    await writeJsonAtomic(index, {
      schemaVersion: 1,
      sessionId,
      workspace: paths.workspaceAlias,
      projectTmp: paths.root,
      captures,
    })
    return index
  }

  /** Stops background collection before the shared database is closed. */
  async dispose(): Promise<void> {
    clearInterval(this.#timer)
    await this.#collecting
    await Promise.allSettled(this.#pending.values())
  }
}
