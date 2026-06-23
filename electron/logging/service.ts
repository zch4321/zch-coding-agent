import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { EventId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  ProviderStats,
  ReplaySummary,
  TraceId,
  TraceInfo,
} from '../../shared/trace'
import type { PermissionMode } from '../../shared/config'
import type { ProviderMessage } from '../providers/provider'
import type { TraceEvent } from './events'
import { readTraceFile } from './reader'
import { replayTrace } from './replay'

const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_TRACE_BYTES = 32 * 1_024 * 1_024

export class TraceServiceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TRACE'
      | 'TRACE_NOT_FOUND'
      | 'TRACE_TOO_LARGE'
      | 'FORK_POINT_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'TraceServiceError'
  }
}

export interface TraceForkPoint {
  workspace: string
  mode: PermissionMode
  sourceEventId: EventId
  messages: ProviderMessage[]
  providerRequest: JsonValue
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

function sumMetric(events: TraceEvent[], names: string[]): number | null {
  let total = 0
  let found = false

  for (const event of events) {
    if (event.type !== 'llm.response') {
      continue
    }

    const usage = jsonObject(event.usage)
    const value = names
      .map((name) => finiteMetric(usage?.[name]))
      .find((candidate) => candidate !== undefined)

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

function providerMessages(value: JsonValue[]): ProviderMessage[] {
  return value.map((candidate) => {
    const object = jsonObject(candidate)

    if (!object) {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork message must be an object',
      )
    }

    const role = object?.role

    if (
      role !== 'system' &&
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'tool'
    ) {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork messages contain an invalid role',
      )
    }

    const content = object.content
    const reasoning = object.reasoning_content
    const toolCallId = object.tool_call_id
    const toolCalls = object.tool_calls

    if (
      content !== undefined &&
      content !== null &&
      typeof content !== 'string'
    ) {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork message content is invalid',
      )
    }

    if (reasoning !== undefined && typeof reasoning !== 'string') {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork reasoning content is invalid',
      )
    }

    if (toolCallId !== undefined && typeof toolCallId !== 'string') {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork tool call id is invalid',
      )
    }

    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new TraceServiceError(
        'INVALID_TRACE',
        'Fork tool calls are invalid',
      )
    }

    return {
      role,
      ...(content !== undefined ? { content } : {}),
      ...(typeof reasoning === 'string'
        ? { reasoning_content: reasoning }
        : {}),
      ...(typeof toolCallId === 'string' ? { tool_call_id: toolCallId } : {}),
      ...(Array.isArray(toolCalls) ? { tool_calls: toolCalls } : {}),
    }
  })
}

export class TraceService {
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

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

  async replay(traceId: TraceId): Promise<ReplaySummary> {
    const { events } = await this.#read(traceId)
    const state = replayTrace(events, { unknownEvent: 'skip' })
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
      forkPoints: events
        .flatMap((event) =>
          event.type === 'llm.request'
            ? [
                {
                  eventId: event.eventId,
                  runId: event.runId,
                  seq: event.seq,
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
      toolCount: Object.keys(state.tools).length,
      approvalCount: state.approvals.length,
      terminalCount: Object.keys(state.terminals).length,
    }
  }

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
      promptTokens: sumMetric(events, ['prompt_tokens']),
      completionTokens: sumMetric(events, ['completion_tokens']),
      totalTokens: sumMetric(events, ['total_tokens']),
      cacheHitTokens: sumMetric(events, [
        'prompt_cache_hit_tokens',
        'cache_hit_tokens',
      ]),
      cacheMissTokens: sumMetric(events, [
        'prompt_cache_miss_tokens',
        'cache_miss_tokens',
      ]),
      averageTtftMs: averageMetric(events, 'ttftMs'),
      averageTotalMs: averageMetric(events, 'totalMs'),
      prefixFingerprints: [
        ...new Set(requests.flatMap((event) => event.prefixFingerprints ?? [])),
      ].slice(-10_000),
    }
  }

  async forkPoint(traceId: TraceId, eventId: EventId): Promise<TraceForkPoint> {
    const { events } = await this.#read(traceId)
    const source = events.find(
      (event) => event.type === 'llm.request' && event.eventId === eventId,
    )
    const start = events.find((event) => event.type === 'session.start')

    if (
      !source ||
      source.type !== 'llm.request' ||
      !start ||
      start.type !== 'session.start'
    ) {
      throw new TraceServiceError(
        'FORK_POINT_NOT_FOUND',
        'Trace fork point was not found',
      )
    }

    const mode: PermissionMode =
      start.mode === 'readonly' ||
      start.mode === 'auto' ||
      start.mode === 'confirm' ||
      start.mode === 'yolo'
        ? start.mode
        : 'confirm'
    return {
      workspace: start.workspace,
      mode,
      sourceEventId: source.eventId,
      messages: providerMessages(source.normalizedMessages),
      providerRequest: structuredClone(source.providerRequest),
    }
  }

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
  ): Promise<{ events: TraceEvent[]; size: number }> {
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

      return { events: await readTraceFile(filePath), size: fileStat.size }
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
