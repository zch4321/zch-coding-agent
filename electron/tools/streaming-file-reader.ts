import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from '../../shared/json'
import { PathGuard, PathGuardError } from '../safety/path-guard'

const READ_CHUNK_BYTES = 64 * 1_024
const CURSOR_VERSION = 1

interface FileCursorPayload {
  v: number
  pathHash: string
  identity: string
  offset: number
  line: number
  continued: boolean
  issuedSize: number
}

interface LineRead {
  content: Buffer
  sourceBytes: number
  complete: boolean
}

export interface StreamingFileReadInput {
  guard: PathGuard
  inputPath: string
  startLine?: number
  cursor?: string
  tail?: boolean
  lineCount: number
  lineNumbers: boolean
  maxOutputBytes: number
  projectionLineLimit: number
  maxWorkspaceSourceBytes: number
  signal?: AbortSignal
}

export interface StreamingFileReadResult {
  content: JsonValue
  totalBytes: number
  truncated: boolean
}

function normalizedPathHash(value: string): string {
  const normalized =
    process.platform === 'win32'
      ? path.resolve(value).toLowerCase()
      : path.resolve(value)
  return createHash('sha256').update(normalized).digest('hex')
}

function fileIdentity(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}`
}

function encodeCursor(payload: FileCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(value: string): FileCursorPayload {
  let candidate: unknown
  try {
    candidate = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new PathGuardError('INVALID_PATH', 'read_file cursor is invalid')
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new PathGuardError('INVALID_PATH', 'read_file cursor is invalid')
  }
  const payload = candidate as Partial<FileCursorPayload>
  if (
    payload.v !== CURSOR_VERSION ||
    typeof payload.pathHash !== 'string' ||
    typeof payload.identity !== 'string' ||
    !Number.isSafeInteger(payload.offset) ||
    Number(payload.offset) < 0 ||
    !Number.isSafeInteger(payload.line) ||
    Number(payload.line) < 1 ||
    typeof payload.continued !== 'boolean' ||
    !Number.isSafeInteger(payload.issuedSize) ||
    Number(payload.issuedSize) < 0
  ) {
    throw new PathGuardError('INVALID_PATH', 'read_file cursor is invalid')
  }
  return payload as FileCursorPayload
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
      }
    }
    position += bytesRead
    if (captured > maximumBytes) {
      return {
        content: Buffer.concat(chunks),
        sourceBytes: maximumBytes + 1,
        complete: false,
      }
    }
  }
  return {
    content: Buffer.concat(chunks),
    sourceBytes: fileSize - offset,
    complete: true,
  }
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

function cursorFor(input: {
  pathHash: string
  identity: string
  offset: number
  line: number
  continued: boolean
  issuedSize: number
}): string {
  return encodeCursor({ v: CURSOR_VERSION, ...input })
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
    const pathHash = normalizedPathHash(guarded.realPath)
    let offset = 0
    let line = input.startLine ?? 1
    let continued = false
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor)
      if (cursor.pathHash !== pathHash || cursor.identity !== identity) {
        throw new PathGuardError(
          'RESOURCE_CHANGED',
          'read_file cursor belongs to a different or replaced file',
        )
      }
      if (metadata.size < cursor.issuedSize || metadata.size < cursor.offset) {
        throw new PathGuardError(
          'RESOURCE_CHANGED',
          'The file was shortened after the read_file cursor was issued',
        )
      }
      offset = cursor.offset
      line = cursor.line
      continued = cursor.continued
    } else if (input.tail) {
      const location = await tailLocation(
        handle,
        input.lineCount,
        metadata.size,
        input.signal,
      )
      offset = location.offset
      line = location.line
    } else {
      offset = await offsetForLine(handle, line, metadata.size, input.signal)
    }

    const startOffset = offset
    const startLine = line
    const startContinued = continued
    const rendered: string[] = []
    let renderedBytes = 0
    let lineTruncated = false
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
      const wholeLine =
        sourceLine.complete && visibleBytes === sourceLine.content.byteLength
      if (wholeLine) {
        offset += sourceLine.sourceBytes
        line += 1
        continued = false
      } else {
        offset += visibleBytes
        continued = true
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
    const startCursor = cursorFor({
      pathHash,
      identity,
      offset: startOffset,
      line: startLine,
      continued: startContinued,
      issuedSize: metadata.size,
    })
    const endCursor = cursorFor({
      pathHash,
      identity,
      offset,
      line,
      continued,
      issuedSize: metadata.size,
    })
    return {
      content: {
        path: guarded.relativePath,
        content: rendered.join('\n'),
        startLine,
        endLine: rendered.length > 0 ? line - (continued ? 0 : 1) : null,
        startCursor,
        endCursor,
        ...(hasMore ? { nextCursor: endCursor } : {}),
        hasMore,
        dataLost: false,
        tailClipped: input.tail === true && hasMore,
        lineTruncated,
        lineContinued: startContinued,
        totalBytes: metadata.size,
        projectionLineLimit: input.projectionLineLimit,
      },
      totalBytes: metadata.size,
      truncated: hasMore,
    }
  } finally {
    await handle.close()
  }
}
