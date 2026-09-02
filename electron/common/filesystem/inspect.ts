import { lstat, realpath, stat } from 'node:fs/promises'
export {
  access as accessPath,
  lstat as linkStatus,
  realpath as canonicalPath,
  stat as fileStatus,
} from 'node:fs/promises'
export { realpathSync as canonicalPathSync } from 'node:fs'
import { isMissingFileError } from './errors'

export interface InspectedPath {
  path: string
  realPath: string
  size: number
  mode: number
  type: 'file' | 'directory'
}

/** Inspects a path without following a final symbolic link. */
export async function inspectPath(
  targetPath: string,
): Promise<InspectedPath | undefined> {
  try {
    const linkStats = await lstat(targetPath)
    if (linkStats.isSymbolicLink()) {
      throw Object.assign(new Error('Symbolic links are not supported'), {
        code: 'ELOOP',
      })
    }
    const canonical = await realpath(targetPath)
    const targetStats = await stat(canonical)
    const type = targetStats.isFile()
      ? 'file'
      : targetStats.isDirectory()
        ? 'directory'
        : undefined
    if (!type) {
      throw Object.assign(
        new Error('Path is not a regular file or directory'),
        {
          code: 'EINVAL',
        },
      )
    }
    return {
      path: targetPath,
      realPath: canonical,
      size: targetStats.size,
      mode: targetStats.mode & 0o777,
      type,
    }
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
}
