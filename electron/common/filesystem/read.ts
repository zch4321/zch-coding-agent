import { readFile } from 'node:fs/promises'
export {
  open as openFileHandle,
  readFile as readFileContents,
} from 'node:fs/promises'
export type { FileHandle } from 'node:fs/promises'
export type { WriteStream } from 'node:fs'

/** Reads one UTF-8 file after rejecting content beyond the configured byte limit. */
export async function readUtf8File(
  filePath: string,
  maximumBytes: number,
): Promise<string> {
  const content = await readFile(filePath)
  if (content.byteLength > maximumBytes) {
    throw Object.assign(
      new Error(`File exceeds the ${maximumBytes} byte limit`),
      { code: 'EFBIG' },
    )
  }
  return content.toString('utf8')
}
