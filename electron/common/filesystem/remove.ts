import { unlink } from 'node:fs/promises'
export { rm as removePath, unlink as unlinkFile } from 'node:fs/promises'
import { isMissingFileError } from './errors'

/** Deletes one file and reports whether this call observed an existing target. */
export async function removeFileIfPresent(
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    await unlink(filePath)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}
