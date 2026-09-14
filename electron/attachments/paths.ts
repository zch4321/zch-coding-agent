import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  canonicalPath,
  linkStatus,
  makeDirectory,
  removePath,
} from '../common/filesystem'

/** Maps opaque project identifiers to portable directory names without Windows path punctuation. */
export function attachmentProjectDirectory(
  root: string,
  projectId: string,
): string {
  return path.join(
    root,
    createHash('sha256').update(projectId).digest('hex').slice(0, 32),
  )
}

/** Creates a private, non-symlink directory beneath an existing trusted root. */
export async function ensureAttachmentDirectory(
  root: string,
  directory: string,
): Promise<void> {
  assertContained(root, directory)
  const relative = path.relative(root, directory)
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await makeDirectory(current, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        )
      )
        throw error
    })
    const info = await linkStatus(current)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Invalid attachment directory')
  }
  assertContained(root, await canonicalPath(directory), true)
}

/** Resolves a managed file after checking every directory and the file itself. */
export async function checkedAttachmentPath(
  root: string,
  file: string,
): Promise<string> {
  assertContained(root, file)
  let current = root
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment)
    if ((await linkStatus(current)).isSymbolicLink())
      throw new Error('Attachment path must not contain symlinks')
  }
  assertContained(root, await canonicalPath(file))
  return file
}

/** Deletes only a checked descendant of the attachment root. */
export async function removeAttachmentDirectory(
  root: string,
  directory: string,
): Promise<void> {
  assertContained(root, directory)
  const info = await linkStatus(directory).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined
    throw error
  })
  if (!info) return
  await checkedAttachmentPath(root, directory)
  await removePath(directory, { recursive: true, force: true })
}

function assertContained(
  root: string,
  target: string,
  allowRoot = false,
): void {
  const relative = path.relative(root, target)
  if (
    (!relative && !allowRoot) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Attachment path escapes storage root')
}
