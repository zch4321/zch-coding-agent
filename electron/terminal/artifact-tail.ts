import { StringDecoder } from 'node:string_decoder'
import { openFileHandle } from '../common/filesystem'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import { sameNativePath } from '../project-artifacts/native-paths'
import {
  BACKGROUND_TAIL_BYTES,
  BACKGROUND_TAIL_LINES,
} from '../../shared/background-tasks'

const BLOCK_BYTES = 32 * 1024
const MAX_SCAN_BYTES = 256 * 1024

export interface TerminalArtifactSource {
  path: string
  root: string
  canonicalRoot?: string
  captureError?: string
}

/** Reads a bounded UTF-8 suffix from a registered regular file inside its trusted root. */
export async function readTerminalArtifactTail(
  artifact: TerminalArtifactSource,
): Promise<{ content: string; truncated: boolean }> {
  const guard = PathGuard.fromCanonical(artifact.root)
  if (
    artifact.canonicalRoot &&
    !sameNativePath(guard.workspacePath, artifact.canonicalRoot)
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Terminal temp entry no longer points to its registered directory',
    )
  }
  const guarded = await guard.resolveExisting(artifact.path)
  const file = await openFileHandle(guarded.realPath, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Terminal log is not a regular file')
    let offset = stat.size
    let scanned = 0
    let newlines = 0
    const blocks: Buffer[] = []
    while (
      offset > 0 &&
      scanned < MAX_SCAN_BYTES &&
      newlines <= BACKGROUND_TAIL_LINES
    ) {
      const length = Math.min(offset, BLOCK_BYTES, MAX_SCAN_BYTES - scanned)
      offset -= length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      const block = buffer.subarray(0, bytesRead)
      for (const byte of block) if (byte === 10) newlines += 1
      blocks.unshift(block)
      scanned += length
    }
    let bytes = Buffer.concat(blocks)
    let start = 0
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
    bytes = bytes.subarray(start)
    const text = new StringDecoder('utf8').write(bytes)
    const lines = text.split('\n')
    const trailingNewline = text.endsWith('\n')
    if (trailingNewline) lines.pop()
    const selected =
      lines.slice(-BACKGROUND_TAIL_LINES).join('\n') +
      (trailingNewline ? '\n' : '')
    const encoded = Buffer.from(selected)
    let trim = Math.max(0, encoded.length - BACKGROUND_TAIL_BYTES)
    while (trim < encoded.length && (encoded[trim]! & 0xc0) === 0x80) trim += 1
    return {
      content: encoded.subarray(trim).toString('utf8'),
      truncated:
        offset > 0 ||
        start > 0 ||
        lines.length > BACKGROUND_TAIL_LINES ||
        trim > 0,
    }
  } finally {
    await file.close()
  }
}
