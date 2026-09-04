import { chmod, stat } from 'node:fs/promises'
export {
  appendFile as appendFileContents,
  chmod as changeFileMode,
  copyFile as copyFileContents,
  link as linkPath,
  rename as renamePath,
  utimes as updateFileTimes,
  writeFile as writeFileContents,
} from 'node:fs/promises'
export { renameSync as renamePathSync } from 'node:fs'
import writeFileAtomic from 'write-file-atomic'
import { isMissingFileError } from './errors'

export interface AtomicWriteOptions {
  signal?: AbortSignal
  mode?: number
  preserveExistingMode?: boolean
}

/** Atomically writes bytes while preserving an existing file's mode. */
export async function writeFileAtomicSafe(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted()
  let existingMode: number | undefined
  if (options.preserveExistingMode !== false) {
    try {
      existingMode = (await stat(filePath)).mode & 0o777
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  const mode = existingMode ?? options.mode
  await writeFileAtomic(filePath, content, {
    ...(typeof content === 'string' ? { encoding: 'utf8' as const } : {}),
    ...(mode === undefined ? {} : { mode }),
  })
  if (mode !== undefined) await chmod(filePath, mode)
}

/** Atomically writes UTF-8 content while preserving an existing file's mode. */
export async function writeUtf8Atomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomicSafe(filePath, content, options)
}
