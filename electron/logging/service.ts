import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { EventId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  ProviderStats,
  ReplaySummary,
  TraceId,
  TraceInfo,
} from '../../shared/trace'
import type {
  SessionTranscriptPage,
  SessionTranscriptRequestMessagesPage,
} from '../../shared/session-transcript'
import type { TraceEvent } from './events'
import { readTraceFile } from './reader'
import { replayTrace } from './replay'
import {
  normalizeSessionTranscript,
  sessionTranscriptToMarkdown,
  type SessionTranscriptDocument,
} from './session-transcript'

const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_TRACE_BYTES = 32 * 1_024 * 1_024
const MAX_TRANSCRIPT_PAGE_BYTES = 2 * 1_024 * 1_024

interface TranscriptCursor {
  kind: 'timeline' | 'request'
  traceId: TraceId
  revision: string
  offset: number
  requestEventId?: EventId
}

/** Reports invalid, missing, or unreadable trace data. */
export class TraceServiceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TRACE'
      | 'TRACE_NOT_FOUND'
      | 'TRACE_TOO_LARGE'
      | 'TRACE_CURSOR_INVALID'
      | 'TRACE_CURSOR_STALE'
      | 'TRACE_REQUEST_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'TraceServiceError'
  }
}

function jsonObject(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function finiteMetric(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function sumUsageMetric(
  events: TraceEvent[],
  name:
    | 'promptTokens'
    | 'completionTokens'
    | 'totalTokens'
    | 'cacheHitTokens'
    | 'cacheMissTokens',
): number | null {
  let total = 0
  let found = false

  for (const event of events) {
    if (event.type !== 'llm.usage') {
      continue
    }
    const value = event.usage[name]

    if (value !== undefined) {
      found = true
      total += value
    }
  }

  return found ? total : null
}

function averageMetric(events: TraceEvent[], name: string): number | null {
  const values = events.flatMap((event) => {
    if (event.type !== 'llm.response') {
      return []
    }

    const value = finiteMetric(jsonObject(event.timing)?.[name])
    return value === undefined ? [] : [value]
  })

  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function truncateJsonStrings(value: JsonValue, maxLength = 200_000): JsonValue {
  if (typeof value === 'string') {
    return value.length > maxLength ? value.slice(0, maxLength) : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateJsonStrings(item, maxLength))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        truncateJsonStrings(item, maxLength),
      ]),
    )
  }

  return value
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeTranscriptCursor(value: string): TranscriptCursor {
  try {
    const candidate = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<TranscriptCursor>
    if (
      (candidate.kind !== 'timeline' && candidate.kind !== 'request') ||
      typeof candidate.traceId !== 'string' ||
      !TRACE_ID.test(candidate.traceId) ||
      typeof candidate.revision !== 'string' ||
      !candidate.revision ||
      !Number.isInteger(candidate.offset) ||
      (candidate.offset ?? -1) < 0 ||
      (candidate.requestEventId !== undefined &&
        typeof candidate.requestEventId !== 'string')
    ) {
      throw new Error('invalid cursor')
    }
    return candidate as TranscriptCursor
  } catch {
    throw new TraceServiceError(
      'TRACE_CURSOR_INVALID',
      'Transcript cursor is invalid',
    )
  }
}

function transcriptRevision(input: {
  traceId: TraceId
  size: number
  mtimeMs: number
  lastSeq: number
}): string {
  return createHash('sha256')
    .update(
      `${input.traceId}\0${input.size}\0${input.mtimeMs}\0${input.lastSeq}`,
    )
    .digest('hex')
}

function boundedPage<T>(
  values: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; nextOffset?: number } {
  const items: T[] = []
  let bytes = 2
  for (
    let index = offset;
    index < values.length && items.length < limit;
    index += 1
  ) {
    const candidate = values[index]
    if (candidate === undefined) break
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (
      items.length > 0 &&
      bytes + candidateBytes > MAX_TRANSCRIPT_PAGE_BYTES
    ) {
      break
    }
    items.push(candidate)
    bytes += candidateBytes
  }
  const next = offset + items.length
  return {
    items,
    ...(next < values.length ? { nextOffset: next } : {}),
  }
}

/** Reads, replays, paginates, exports, summarizes, and cleans up trace logs. */
export class TraceService {
  constructor(readonly directory: string) {}

  /** Creates the trace directory when it does not already exist. */
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  /** Lists valid trace files and returns their bounded metadata. */
  async list(): Promise<TraceInfo[]> {
    await this.initialize()
    const entries = await readdir(this.directory, { withFileTypes: true })
    const traces: TraceInfo[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue
      }

      const traceId = entry.name.slice(0, -6)

      if (!TRACE_ID.test(traceId)) {
        continue
      }

      try {
        const { events, size } = await this.#read(traceId as TraceId)
        const start = events.find((event) => event.type === 'session.start')
        const end = [...events]
          .reverse()
          .find((event) => event.type === 'session.end')
        traces.push({
          traceId: traceId as TraceId,
          ...(start ? { sessionId: start.sessionId, startedAt: start.ts } : {}),
          ...(end ? { endedAt: end.ts } : {}),
          closed: Boolean(end),
          size,
          eventCount: events.length,
        })
      } catch {
        // Invalid traces remain on disk for manual diagnosis but are not exposed.
      }
    }

    return traces
      .sort((left, right) =>
        (right.startedAt ?? '').localeCompare(left.startedAt ?? ''),
      )
      .slice(0, 1_000)
  }

  /** Loads a trace and returns its reduced replay summary. */
  async replay(traceId: TraceId): Promise<ReplaySummary> {
    const { events } = await this.#read(traceId)
    const state = replayTrace(events)
    return {
      traceId,
      lastSeq: state.lastSeq,
      skippedEvents: state.skippedEvents,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.workspace ? { workspace: state.workspace } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.mode ? { mode: state.mode } : {}),
      closed: state.closed,
      runs: Object.entries(state.runs)
        .slice(-10_000)
        .map(([runId, status]) => ({
          runId: runId as keyof typeof state.runs,
          status: status ?? 'failed',
        })),
      requests: events
        .flatMap((event) =>
          event.type === 'llm.request'
            ? [
                {
                  eventId: event.eventId,
                  runId: event.runId,
                  seq: event.seq,
                  messages: event.normalizedMessages
                    .slice(0, 10_000)
                    .map((message) => truncateJsonStrings(message)),
                  ...(event.promptBuild
                    ? { promptBuild: structuredClone(event.promptBuild) }
                    : {}),
                },
              ]
            : [],
        )
        .slice(-10_000),
      messages: state.messages.slice(-10_000).map((message) => ({
        ...message,
        text: message.text.slice(0, 200_000),
        ...(message.reasoning
          ? { reasoning: message.reasoning.slice(0, 200_000) }
          : {}),
      })),
      interjections: state.interjections.slice(-10_000).map((interjection) => ({
        ...interjection,
        content: interjection.content.slice(0, 200_000),
        history: interjection.history.slice(-10_000).map((entry) => ({
          ...entry,
          content: entry.content.slice(0, 200_000),
        })),
      })),
      toolCount: Object.keys(state.tools).length,
      approvalCount: state.approvals.length,
      terminalCount: Object.keys(state.terminals).length,
    }
  }

  /** Loads a trace and builds its normalized session transcript document. */
  async transcriptDocument(
    traceId: TraceId,
  ): Promise<SessionTranscriptDocument> {
    const snapshot = await this.#read(traceId)
    const lastSeq = snapshot.events.at(-1)?.seq ?? 0
    const revision = transcriptRevision({
      traceId,
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      lastSeq,
    })
    return normalizeSessionTranscript(snapshot.events, {
      traceId,
      revision,
      active: !snapshot.events.some((event) => event.type === 'session.end'),
    })
  }

  /** Returns a bounded transcript page using an opaque cursor. */
  async transcriptPage(input: {
    traceId: TraceId
    cursor?: string
    limit?: number
  }): Promise<SessionTranscriptPage> {
    const document = await this.transcriptDocument(input.traceId)
    const cursor = input.cursor
      ? decodeTranscriptCursor(input.cursor)
      : undefined
    if (
      cursor &&
      (cursor.kind !== 'timeline' || cursor.traceId !== input.traceId)
    ) {
      throw new TraceServiceError(
        'TRACE_CURSOR_INVALID',
        'Transcript cursor does not belong to this timeline',
      )
    }
    if (cursor && cursor.revision !== document.metadata.revision) {
      throw new TraceServiceError(
        'TRACE_CURSOR_STALE',
        'Trace changed after the transcript snapshot was opened',
      )
    }
    const limit = Math.min(100, Math.max(1, input.limit ?? 50))
    const offset = cursor?.offset ?? 0
    if (offset > document.entries.length) {
      throw new TraceServiceError(
        'TRACE_CURSOR_INVALID',
        'Transcript cursor offset is invalid',
      )
    }
    const page = boundedPage(document.entries, offset, limit)
    return {
      metadata: document.metadata,
      total: document.entries.length,
      entries: page.items,
      ...(page.nextOffset !== undefined
        ? {
            nextCursor: encodeTranscriptCursor({
              kind: 'timeline',
              traceId: input.traceId,
              revision: document.metadata.revision,
              offset: page.nextOffset,
            }),
          }
        : {}),
    }
  }

  /** Extracts provider request messages for one trace request event with pagination. */
  async transcriptRequestMessages(input: {
    traceId: TraceId
    requestEventId: EventId
    cursor?: string
    limit?: number
  }): Promise<SessionTranscriptRequestMessagesPage> {
    const document = await this.transcriptDocument(input.traceId)
    const messages = document.requestMessages.get(input.requestEventId)
    if (!messages) {
      throw new TraceServiceError(
        'TRACE_REQUEST_NOT_FOUND',
        'Provider request was not found in this trace',
      )
    }
    const cursor = input.cursor
      ? decodeTranscriptCursor(input.cursor)
      : undefined
    if (
      cursor &&
      (cursor.kind !== 'request' ||
        cursor.traceId !== input.traceId ||
        cursor.requestEventId !== input.requestEventId)
    ) {
      throw new TraceServiceError(
        'TRACE_CURSOR_INVALID',
        'Transcript cursor does not belong to this provider request',
      )
    }
    if (cursor && cursor.revision !== document.metadata.revision) {
      throw new TraceServiceError(
        'TRACE_CURSOR_STALE',
        'Trace changed after the provider request snapshot was opened',
      )
    }
    const limit = Math.min(25, Math.max(1, input.limit ?? 10))
    const offset = cursor?.offset ?? 0
    if (offset > messages.length) {
      throw new TraceServiceError(
        'TRACE_CURSOR_INVALID',
        'Provider request cursor offset is invalid',
      )
    }
    const page = boundedPage(messages, offset, limit)
    return {
      traceId: input.traceId,
      revision: document.metadata.revision,
      requestEventId: input.requestEventId,
      total: messages.length,
      messages: page.items,
      ...(page.nextOffset !== undefined
        ? {
            nextCursor: encodeTranscriptCursor({
              kind: 'request',
              traceId: input.traceId,
              revision: document.metadata.revision,
              requestEventId: input.requestEventId,
              offset: page.nextOffset,
            }),
          }
        : {}),
    }
  }

  /** Renders a trace transcript document as Markdown. */
  async transcriptMarkdown(traceId: TraceId): Promise<string> {
    return sessionTranscriptToMarkdown(await this.transcriptDocument(traceId))
  }

  /** Aggregates provider statistics for one trace or for all available traces. */
  async stats(traceId?: TraceId): Promise<ProviderStats> {
    const events = traceId
      ? (await this.#read(traceId)).events
      : (
          await Promise.all(
            (await this.list()).map(
              async (trace) => (await this.#read(trace.traceId)).events,
            ),
          )
        ).flat()
    const requests = events.filter((event) => event.type === 'llm.request')
    return {
      requestCount: requests.length,
      requestBytes: requests.reduce(
        (sum, event) => sum + event.requestBytes,
        0,
      ),
      promptTokens: sumUsageMetric(events, 'promptTokens'),
      completionTokens: sumUsageMetric(events, 'completionTokens'),
      totalTokens: sumUsageMetric(events, 'totalTokens'),
      cacheHitTokens: sumUsageMetric(events, 'cacheHitTokens'),
      cacheMissTokens: sumUsageMetric(events, 'cacheMissTokens'),
      averageTtftMs: averageMetric(events, 'ttftMs'),
      averageTotalMs: averageMetric(events, 'totalMs'),
    }
  }

  /** Deletes trace files not listed as active and returns the deletion count. */
  async clearClosed(activeTraceIds: ReadonlySet<string>): Promise<number> {
    const traces = await this.list()
    let deleted = 0

    for (const trace of traces) {
      if (!trace.closed || activeTraceIds.has(trace.traceId)) {
        continue
      }

      await unlink(this.#path(trace.traceId))
      deleted += 1
    }

    return deleted
  }

  #path(traceId: TraceId): string {
    if (!TRACE_ID.test(traceId)) {
      throw new TraceServiceError('INVALID_TRACE', 'Trace id is invalid')
    }

    return path.join(this.directory, `${traceId}.jsonl`)
  }

  async #read(
    traceId: TraceId,
  ): Promise<{ events: TraceEvent[]; size: number; mtimeMs: number }> {
    const filePath = this.#path(traceId)

    try {
      const fileStat = await lstat(filePath)

      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new TraceServiceError(
          'INVALID_TRACE',
          'Trace is not a regular file',
        )
      }

      if (fileStat.size > MAX_TRACE_BYTES) {
        throw new TraceServiceError(
          'TRACE_TOO_LARGE',
          'Trace exceeds the replay size limit',
        )
      }

      return {
        events: await readTraceFile(filePath),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      }
    } catch (error) {
      if (error instanceof TraceServiceError) {
        throw error
      }

      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new TraceServiceError('TRACE_NOT_FOUND', 'Trace was not found')
      }

      throw error
    }
  }
}
