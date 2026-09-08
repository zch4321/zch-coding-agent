import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  canonicalPath,
  isMissingFileError,
  linkStatus,
  readDirectory,
  readFileContents,
  removePath,
  renamePath,
  writeFileContents,
} from '../common/filesystem'
import type { SessionId } from '../../shared/ids'
import type { ArtifactKind } from '../../shared/project-artifacts'
import type { DatabaseService } from '../persistence/database-service'
import type { ProjectArtifactRepository } from '../persistence/project-artifact-repository'
import type { SessionTempService } from '../session-temp/service'
import { bindLegacyScratch, copyLegacyCapture } from './legacy-copy'
import { prepareArtifactPath } from './native-paths'

interface LegacyMigration {
  database: DatabaseService
  repository: ProjectArtifactRepository
  projectId: string
  tmp: string
  legacy: SessionTempService
  now(): number
  onDiagnostic(message: string, error?: unknown): void
}

const KINDS: ArtifactKind[] = [
  'commands',
  'terminals',
  'subagents',
  'swarms',
  'fetch',
  'web-search',
  'mcp',
]

async function verifyLegacyRoot(
  legacy: SessionTempService,
  sessionId: string,
): Promise<string | undefined> {
  const root = legacy.pathsFor(sessionId as SessionId).root
  const info = await linkStatus(root).catch((error: unknown) => {
    if (isMissingFileError(error)) return undefined
    throw error
  })
  if (!info) return undefined
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && info.uid !== process.getuid?.())
  )
    throw new Error('Legacy Session root ownership mismatch')
  const marker = JSON.parse(
    await readFileContents(path.join(root, '.session-temp.json'), 'utf8'),
  )
  if (
    marker.schemaVersion !== 1 ||
    marker.sessionHash !== createHash('sha256').update(sessionId).digest('hex')
  )
    throw new Error('Legacy Session marker ownership mismatch')
  return root
}

async function verifyLegacyParent(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Legacy path is outside its Session root')
  let current = root
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment)
    const info = await linkStatus(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Legacy capture parent was replaced')
  }
}

/** Removes only a registered legacy capture after verifying the original Session owner and ancestors. */
export async function removeLegacyCapture(
  legacy: SessionTempService,
  mapping: { sessionId: string; oldPath: string },
): Promise<void> {
  const root = await verifyLegacyRoot(legacy, mapping.sessionId)
  if (!root) return
  try {
    await verifyLegacyParent(root, mapping.oldPath)
    await removePath(mapping.oldPath, { recursive: true, force: true })
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

/** Registers migrations before I/O, resumes pending copies, and preserves canonical message history. */
export async function migrateLegacyArtifacts(
  input: LegacyMigration,
): Promise<void> {
  const sessions = input.database.read((reader) =>
    reader
      .prepare('SELECT id FROM sessions WHERE project_id = ? ORDER BY id')
      .all(input.projectId),
  )
  for (const row of sessions) {
    const sessionId = String(row.id) as SessionId
    try {
      const root = await verifyLegacyRoot(input.legacy, sessionId)
      if (!root) continue
      const legacy = input.legacy.pathsFor(sessionId)
      const artifactsInfo = await linkStatus(legacy.artifacts).catch(
        () => undefined,
      )
      if (artifactsInfo?.isDirectory() && !artifactsInfo.isSymbolicLink()) {
        for (const kind of KINDS) {
          const directory = path.join(legacy.artifacts, kind)
          const info = await linkStatus(directory).catch(() => undefined)
          if (!info?.isDirectory() || info.isSymbolicLink()) continue
          for (const entry of await readDirectory(directory, {
            withFileTypes: true,
          })) {
            if (!entry.isFile() && !entry.isDirectory()) continue
            const source = path.join(directory, entry.name)
            await input.database.withTransaction((transaction) => {
              const sourceKey =
                kind === 'terminals'
                  ? `legacy:${entry.name}`
                  : ['web-search', 'mcp'].includes(kind)
                    ? entry.name.replace(/\.json$/u, '')
                    : entry.name
              const record = input.repository.allocate(transaction, {
                projectId: input.projectId,
                kind,
                ownerSessionId: sessionId,
                sourceKey,
                now: input.now(),
              })
              if (record.status !== 'expired')
                input.repository.rememberLegacy(
                  transaction,
                  input.projectId,
                  sessionId,
                  source,
                  record.relativePath,
                )
            })
          }
        }
      }
      const scratch = await linkStatus(legacy.scratch).catch(() => undefined)
      if (
        scratch?.isDirectory() &&
        !scratch.isSymbolicLink() &&
        (await readDirectory(legacy.scratch)).length
      ) {
        await input.database.withTransaction((transaction) => {
          if (
            input.repository
              .legacy(transaction, input.projectId)
              .some((entry) => entry.oldPath === legacy.scratch)
          )
            return
          transaction
            .prepare(
              "INSERT INTO project_artifact_sequences(project_id, kind, next_id) VALUES (?, 'scratch-imports', 1) ON CONFLICT DO NOTHING",
            )
            .run(input.projectId)
          const sequence = transaction
            .prepare(
              "UPDATE project_artifact_sequences SET next_id = next_id + 1 WHERE project_id = ? AND kind = 'scratch-imports' RETURNING next_id - 1 AS id",
            )
            .get(input.projectId)
          const id = Number(sequence?.id)
          if (!Number.isSafeInteger(id))
            throw new Error('Scratch import ID space is exhausted')
          input.repository.rememberLegacy(
            transaction,
            input.projectId,
            sessionId,
            legacy.scratch,
            `scratch/imports/${id}`,
          )
        })
      }
      await input.database.withTransaction((transaction) => {
        for (const [oldPath, relative] of [
          [legacy.root, ''],
          [legacy.artifacts, 'artifacts'],
        ]) {
          input.repository.rememberLegacy(
            transaction,
            input.projectId,
            sessionId,
            oldPath,
            relative,
          )
          input.repository.completeLegacy(transaction, input.projectId, oldPath)
        }
      })
    } catch (error) {
      input.onDiagnostic('Legacy project artifact discovery failed', error)
    }
  }
  const mappings = input.database.read((reader) =>
    input.repository.legacy(reader, input.projectId),
  )
  for (const mapping of mappings.filter((entry) => entry.state === 'pending')) {
    try {
      const root = await verifyLegacyRoot(input.legacy, mapping.sessionId)
      if (!root)
        throw new Error('Legacy source is missing; migration remains pending')
      await verifyLegacyParent(root, mapping.oldPath)
      const target = path.join(input.tmp, mapping.relativePath)
      const scratch = mapping.relativePath.startsWith('scratch/imports/')
      const sourceInfo = await linkStatus(mapping.oldPath).catch(
        (error: unknown) => {
          if (isMissingFileError(error)) return undefined
          throw error
        },
      )
      if (!scratch || !sourceInfo?.isSymbolicLink())
        await copyLegacyCapture(
          input.tmp,
          scratch && !sourceInfo
            ? `${mapping.oldPath}.migration-original`
            : mapping.oldPath,
          target,
        )
      if (scratch) await bindLegacyScratch(mapping.oldPath, target)
      await input.database.withTransaction((transaction) => {
        input.repository.completeLegacy(
          transaction,
          input.projectId,
          mapping.oldPath,
        )
        const record = input.repository.byPath(
          transaction,
          input.projectId,
          mapping.relativePath,
        )
        if (record) input.repository.finish(transaction, record, input.now())
      })
    } catch (error) {
      input.onDiagnostic(
        'Legacy project artifact migration failed; retained source can be retried',
        error,
      )
    }
  }
  const ready = input.database
    .read((reader) => input.repository.legacy(reader, input.projectId))
    .filter((entry) => entry.state === 'ready')
  for (const mapping of ready.filter((entry) =>
    /^artifacts\/swarms\/\d+$/u.test(entry.relativePath),
  )) {
    const file = path.join(input.tmp, mapping.relativePath, 'manifest.json')
    try {
      const info = await linkStatus(file)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8 * 1024 * 1024
      )
        continue
      if (
        !(await canonicalPath(file)).startsWith(
          `${await canonicalPath(input.tmp)}${path.sep}`,
        )
      )
        throw new Error('Legacy manifest escaped its project')
      const manifest = JSON.parse(await readFileContents(file, 'utf8'))
      if (manifest.schemaVersion === 3) continue
      if (!Array.isArray(manifest.children)) continue
      for (const child of manifest.children) {
        if (!child || typeof child.artifactPath !== 'string') continue
        const childMapping = ready.find(
          (entry) => entry.oldPath === child.artifactPath,
        )
        if (childMapping)
          child.artifactPath = path.join(input.tmp, childMapping.relativePath)
      }
      manifest.schemaVersion = 3
      const stage = `${file}.migration`
      await prepareArtifactPath(input.tmp, stage)
      await writeFileContents(stage, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      })
      await renamePath(stage, file)
    } catch (error) {
      if (!isMissingFileError(error))
        input.onDiagnostic('Legacy manifest path migration failed', error)
    }
  }
}
