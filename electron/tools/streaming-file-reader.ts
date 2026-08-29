import { open, stat } from 'node:fs/promises'
import type { JsonValue } from '../../shared/json'
import { PathGuard, PathGuardError } from '../safety/path-guard'

const READ_CHUNK_BYTES = 64 * 1_024

interface LineRead {
  content: Buffer
  sourceBytes: number
  complete: boolean
  terminated: boolean
}

export interface StreamingFileReadInput {
  guard: PathGuard
  inputPath: string
  startLine?: number
  startCharacter?: number
  tail?: boolean
  lineCount: number
  lineNumbers: boolean
  maxOutputBytes: number
  maxWorkspaceSourceBytes: number
  signal?: AbortSignal
}

export interface StreamingFileReadResult {
  content: JsonValue
  totalBytes: number
  truncated: boolean
}

function fileIdentity(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}`
}

function safeUtf8PrefixLength(value: Buffer, maximumBytes: number): number {
  let length = Math.min(value.byteLength, Math.max(0, maximumBytes))
  if (length === value.byteLength) return length
  while (length > 0 && (value[length] & 0xc0) === 0x80) length -= 1
  if (length === 0) return 0
  const lead = value[length]
  const expected =
    lead < 0x80
      ? 1
      : lead >= 0xc2 && lead <= 0xdf
        ? 2
        : lead >= 0xe0 && lead <= 0xef
          ? 3
          : lead >= 0xf0 && lead <= 0xf4
            ? 4
            : 1
  return length + expected <= maximumBytes ? length + expected : length
}

async function readLine(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  fileSize: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<LineRead | undefined> {
  if (offset >= fileSize) return undefined
  const chunks: Buffer[] = []
  let captured = 0
  let position = offset
  while (position < fileSize) {
    signal?.throwIfAborted()
    const requested = Math.min(READ_CHUNK_BYTES, fileSize - position)
    const buffer = Buffer.allocUnsafe(requested)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    const newline = chunk.indexOf(0x0a)
    const visible = newline >= 0 ? chunk.subarray(0, newline) : chunk
    const remaining = Math.max(0, maximumBytes + 1 - captured)
    if (remaining > 0) {
      const retained = visible.subarray(0, remaining)
      chunks.push(retained)
      captured += retained.byteLength
    }
    if (newline >= 0) {
      const joined = Buffer.concat(chunks)
      const withoutCarriageReturn =
        joined.at(-1) === 0x0d ? joined.subarray(0, -1) : joined
      return {
        content: withoutCarriageReturn,
        sourceBytes: position - offset + newline + 1,
        complete: captured <= maximumBytes,
        terminated: true,
      }
    }
    position += bytesRead
    if (captured > maximumBytes) {
      return {
        content: Buffer.concat(chunks),
        sourceBytes: maximumBytes + 1,
        complete: false,
        terminated: false,
      }
    }
  }
  return {
    content: Buffer.concat(chunks),
    sourceBytes: fileSize - offset,
    complete: true,
    terminated: false,
  }
}

function completeUtf8PrefixLength(
  value: Buffer,
  moreBytesFollow: boolean,
): number {
  if (!moreBytesFollow || value.byteLength === 0) return value.byteLength
  let lead = value.byteLength - 1
  while (lead >= 0 && (value[lead] & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return 0
  const leadByte = value[lead]
  const expected =
    leadByte < 0x80
      ? 1
      : leadByte >= 0xc2 && leadByte <= 0xdf
        ? 2
        : leadByte >= 0xe0 && leadByte <= 0xef
          ? 3
          : leadByte >= 0xf0 && leadByte <= 0xf4
            ? 4
            : 1
  return value.byteLength - lead < expected ? lead : value.byteLength
}

async function offsetForCharacter(
  handle: Awaited<ReturnType<typeof open>>,
  lineOffset: number,
  requestedCharacter: number,
  fileSize: number,
  signal?: AbortSignal,
): Promise<number> {
  if (requestedCharacter === 0) return lineOffset
  let remaining = requestedCharacter
  let position = lineOffset
  while (position < fileSize) {
    signal?.throwIfAborted()
    const requested = Math.min(READ_CHUNK_BYTES, fileSize - position)
    const buffer = Buffer.allocUnsafe(requested)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    const newline = chunk.indexOf(0x0a)
    let visibleEnd = newline >= 0 ? newline : chunk.byteLength
    if (newline >= 0 && visibleEnd > 0 && chunk[visibleEnd - 1] === 0x0d) {
      visibleEnd -= 1
    }
    const visible = chunk.subarray(0, visibleEnd)
    const safeLength = completeUtf8PrefixLength(
      visible,
      newline < 0 && position + bytesRead < fileSize,
    )
    const safe = visible.subarray(0, safeLength)
    const characters = [...safe.toString('utf8')]
    if (remaining <= characters.length) {
      return (
        position +
        Buffer.byteLength(characters.slice(0, remaining).join(''), 'utf8')
      )
    }
    remaining -= characters.length
    if (newline >= 0) break
    if (safeLength === 0) {
      throw new PathGuardError(
        'INVALID_POSITION',
        'read_file could not resolve startCharacter in invalid UTF-8 data',
      )
    }
    position += safeLength
  }
  throw new PathGuardError(
    'INVALID_POSITION',
    'read_file startCharacter exceeds the selected line length',
  )
}

async function offsetForLine(
  handle: Awaited<ReturnType<typeof open>>,
  requestedLine: number,
  fileSize: number,
  signal?: AbortSignal,
): Promise<number> {
  if (requestedLine <= 1) return 0
  let line = 1
  let position = 0
  while (position < fileSize) {
    signal?.throwIfAborted()
    const requested = Math.min(READ_CHUNK_BYTES, fileSize - position)
    const buffer = Buffer.allocUnsafe(requested)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead === 0) break
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue
      line += 1
      if (line === requestedLine) return position + index + 1
    }
    position += bytesRead
  }
  return fileSize
}

async function tailLocation(
  handle: Awaited<ReturnType<typeof open>>,
  requestedLines: number,
  fileSize: number,
  signal?: AbortSignal,
): Promise<{ offset: number; line: number }> {
  if (fileSize === 0) return { offset: 0, line: 1 }
  const retainedNewlines: number[] = []
  let newlineCount = 0
  let position = 0
  let finalByte = -1
  while (position < fileSize) {
    signal?.throwIfAborted()
    const requested = Math.min(READ_CHUNK_BYTES, fileSize - position)
    const buffer = Buffer.allocUnsafe(requested)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead === 0) break
    finalByte = buffer[bytesRead - 1] ?? finalByte
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue
      newlineCount += 1
      retainedNewlines.push(position + index)
      if (retainedNewlines.length > requestedLines + 1) {
        retainedNewlines.shift()
      }
    }
    position += bytesRead
  }
  const totalLines = newlineCount + (finalByte === 0x0a ? 0 : 1)
  const line = Math.max(1, totalLines - requestedLines + 1)
  if (line === 1) return { offset: 0, line }
  const targetNewlineOrdinal = line - 1
  const firstRetainedOrdinal = newlineCount - retainedNewlines.length + 1
  const index = targetNewlineOrdinal - firstRetainedOrdinal
  const newlineOffset = retainedNewlines[index]
  return {
    offset: newlineOffset === undefined ? 0 : newlineOffset + 1,
    line,
  }
}

/** Streams one bounded UTF-8 page without loading the complete source file. */
export async function readStreamingFile(
  input: StreamingFileReadInput,
): Promise<StreamingFileReadResult> {
  const guarded = await input.guard.resolveExisting(input.inputPath)
  const handle = await open(guarded.realPath, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new PathGuardError('NOT_A_FILE', 'Path is not a regular file')
    }
    if (
      guarded.rootKind === 'workspace' &&
      metadata.size > input.maxWorkspaceSourceBytes
    ) {
      throw new PathGuardError(
        'FILE_TOO_LARGE',
        `read_file supports workspace files up to ${input.maxWorkspaceSourceBytes} bytes`,
      )
    }
    const identity = fileIdentity(metadata)
    let offset = 0
    let line = input.startLine ?? 1
    let character = input.startCharacter ?? 0
    if (input.tail) {
      const location = await tailLocation(
        handle,
        input.lineCount,
        metadata.size,
        input.signal,
      )
      offset = location.offset
      line = location.line
      character = 0
    } else {
      offset = await offsetForLine(handle, line, metadata.size, input.signal)
      offset = await offsetForCharacter(
        handle,
        offset,
        character,
        metadata.size,
        input.signal,
      )
    }

    const startLine = line
    const startCharacter = character
    const rendered: string[] = []
    let renderedBytes = 0
    let lineTruncated = false
    let endLine: number | null = null
    while (offset < metadata.size && rendered.length < input.lineCount) {
      input.signal?.throwIfAborted()
      const prefix = input.lineNumbers ? `${line}\t` : ''
      const separator = rendered.length === 0 ? '' : '\n'
      const fixedBytes = Buffer.byteLength(`${separator}${prefix}`, 'utf8')
      const available = input.maxOutputBytes - renderedBytes - fixedBytes
      if (available <= 0) break
      const sourceLine = await readLine(
        handle,
        offset,
        metadata.size,
        Math.max(available, 1),
        input.signal,
      )
      if (!sourceLine) break
      const visibleBytes = safeUtf8PrefixLength(sourceLine.content, available)
      if (visibleBytes === 0 && sourceLine.content.byteLength > 0) break
      const visible = sourceLine.content.subarray(0, visibleBytes)
      rendered.push(`${prefix}${visible.toString('utf8')}`)
      renderedBytes += fixedBytes + visible.byteLength
      endLine = line
      const visibleCharacters = [...visible.toString('utf8')].length
      const wholeLine =
        sourceLine.complete && visibleBytes === sourceLine.content.byteLength
      if (wholeLine) {
        offset += sourceLine.sourceBytes
        if (sourceLine.terminated) {
          line += 1
          character = 0
        } else {
          character += visibleCharacters
        }
      } else {
        offset += visibleBytes
        character += visibleCharacters
        lineTruncated = true
        break
      }
    }
    const postRead = await stat(guarded.absolutePath)
    if (fileIdentity(postRead) !== identity) {
      throw new PathGuardError(
        'RESOURCE_CHANGED',
        'The file was replaced while it was being read',
      )
    }
    const hasMore = offset < metadata.size
    return {
      content: {
        path: guarded.relativePath,
        content: rendered.join('\n'),
        startLine,
        startCharacter,
        endLine,
        nextStartLine: line,
        ...(character > 0 ? { nextStartCharacter: character } : {}),
        hasMore,
        tailClipped: input.tail === true && hasMore,
        lineTruncated,
        totalBytes: metadata.size,
      },
      totalBytes: metadata.size,
      truncated: hasMore,
    }
  } finally {
    await handle.close()
  }
}
