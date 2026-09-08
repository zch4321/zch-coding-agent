import path from 'node:path'
import {
  changeFileMode,
  isMissingFileError,
  linkStatus,
  makeDirectory,
} from '../common/filesystem'

/** Creates a private real directory without accepting a replacement link or foreign owner. */
export async function privateArtifactDirectory(
  directory: string,
): Promise<void> {
  await makeDirectory(directory, { recursive: true, mode: 0o700 })
  const info = await linkStatus(directory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Project artifact directory is not a real directory')
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid?.())
      throw new Error('Project artifact directory belongs to another user')
    await changeFileMode(directory, 0o700)
  }
}

/** Validates each managed ancestor before creating the next, and rejects replaced capture leaves. */
export async function prepareArtifactPath(
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Artifact path is outside its managed root')
  await privateArtifactDirectory(root)
  let directory = root
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, segment)
    await privateArtifactDirectory(directory)
  }
  const info = await linkStatus(target).catch((error: unknown) => {
    if (isMissingFileError(error)) return undefined
    throw error
  })
  if (
    info &&
    ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink())
  )
    throw new Error('Artifact capture path was replaced')
}

/** Compares native targets including Windows drive, UNC and namespace spellings. */
export function sameNativePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32'
      ? path.toNamespacedPath(path.resolve(value)).toLowerCase()
      : path.resolve(value)
  return normalize(left) === normalize(right)
}
