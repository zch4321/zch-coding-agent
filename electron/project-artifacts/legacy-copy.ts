import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  copyDirectory,
  createSymbolicLink,
  isMissingFileError,
  linkStatus,
  openFileHandle,
  readDirectory,
  readSymbolicLink,
  removePath,
  renamePath,
} from '../common/filesystem'
import { prepareArtifactPath, sameNativePath } from './native-paths'

async function fingerprint(target: string): Promise<string> {
  const info = await linkStatus(target)
  if (info.isSymbolicLink())
    throw new Error('Legacy capture contains an unmanaged link')
  const hash = createHash('sha256')
  if (info.isDirectory()) {
    hash.update('directory\0')
    for (const name of (await readDirectory(target)).sort())
      hash.update(
        JSON.stringify([name, await fingerprint(path.join(target, name))]),
      )
  } else if (info.isFile()) {
    hash.update('file\0')
    const file = await openFileHandle(target, 'r')
    try {
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hash.update(chunk)
    } finally {
      await file.close()
    }
  } else throw new Error('Legacy capture is not a regular file or directory')
  return hash.digest('hex')
}

/** Replaces the retained scratch directory with a native entry so old Shell and tool writes stay in sync. */
export async function bindLegacyScratch(
  source: string,
  target: string,
): Promise<void> {
  const backup = `${source}.migration-original`
  const stage = `${source}.migration-link`
  const info = await linkStatus(source).catch((error: unknown) => {
    if (isMissingFileError(error)) return undefined
    throw error
  })
  if (info?.isSymbolicLink()) {
    if (
      !sameNativePath(
        path.resolve(path.dirname(source), await readSymbolicLink(source)),
        target,
      )
    )
      throw new Error('Legacy scratch entry target was replaced')
    await removePath(backup, { recursive: true, force: true })
    return
  }
  const staged = await linkStatus(stage).catch((error: unknown) => {
    if (isMissingFileError(error)) return undefined
    throw error
  })
  if (staged) {
    if (
      !staged.isSymbolicLink() ||
      !sameNativePath(
        path.resolve(path.dirname(stage), await readSymbolicLink(stage)),
        target,
      )
    )
      throw new Error('Legacy scratch staging entry was replaced')
    await removePath(stage, { force: true })
  }
  await createSymbolicLink(
    target,
    stage,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  if (info) {
    if (
      await linkStatus(backup).then(
        () => true,
        (error: unknown) => {
          if (isMissingFileError(error)) return false
          throw error
        },
      )
    )
      throw new Error('Legacy scratch backup already exists')
    await renamePath(source, backup)
  }
  await renamePath(stage, source)
  await removePath(backup, { recursive: true, force: true })
}

/** Copies immutable legacy output atomically, retaining the old native path until the capture expires. */
export async function copyLegacyCapture(
  root: string,
  source: string,
  target: string,
): Promise<void> {
  await prepareArtifactPath(root, target)
  const expected = await fingerprint(source)
  const existing = await linkStatus(target).catch((error: unknown) => {
    if (isMissingFileError(error)) return undefined
    throw error
  })
  if (existing) {
    if ((await fingerprint(target)) !== expected)
      throw new Error(
        'Legacy migration destination does not match its retained source',
      )
    return
  }
  const stage = `${target}.migration`
  await prepareArtifactPath(root, stage)
  await removePath(stage, { recursive: true, force: true })
  await copyDirectory(source, stage, {
    recursive: true,
    dereference: false,
    force: false,
    errorOnExist: true,
  })
  if (
    (await fingerprint(stage)) !== expected ||
    (await fingerprint(source)) !== expected
  )
    throw new Error('Legacy capture changed during migration')
  await renamePath(stage, target)
}
