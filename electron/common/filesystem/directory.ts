import { mkdir } from 'node:fs/promises'
export {
  mkdir as makeDirectory,
  mkdtemp as makeTemporaryDirectory,
  readdir as readDirectory,
} from 'node:fs/promises'

/** Creates a directory and any missing parents. */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true })
}
