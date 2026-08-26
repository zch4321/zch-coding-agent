import type { JsonValue } from '../../shared/json'
import {
  SESSION_TRANSCRIPT_FORMAT,
  SESSION_TRANSCRIPT_SCHEMA_VERSION,
  type SessionTranscriptEntry,
  type SessionTranscriptMetadata,
} from '../../shared/session-transcript'
import type { TraceId } from '../../shared/trace'
import type { TraceEvent } from './events'

export interface SessionTranscriptDocument {
  metadata: SessionTranscriptMetadata
  entries: SessionTranscriptEntry[]
  requestMessages: Map<string, JsonValue[]>
}

interface TranscriptOptions {
  traceId: TraceId
  revision: string
  generatedAt?: string
  active?: boolean
}

interface ToolAggregate {
  proposed?: Extract<TraceEvent, { type: 'tool.proposed' }>
  approval?: Extract<TraceEvent, { type: 'approval' }>
  attempt?: Extract<TraceEvent, { type: 'tool.attempt' }>
  call?: Extract<TraceEvent, { type: 'tool.call' }>
}

interface StreamAggregate {
  seq: number
  ts: string
  runId: Extract<TraceEvent, { type: 'llm.stream' }>['runId']
  text: string
  reasoning: string
  completed: boolean
}

const MULTIMODAL_TYPE =
  /^(?:image|input_image|output_image|image_url|audio|input_audio|output_audio|video|blob)$/iu
const MULTIMODAL_MIME = /^(?:image|audio|video)\//iu
const DATA_URL = /^data:((?:image|audio|video)\/[^;,]+);base64,/iu

function jsonClone(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function mediaPlaceholder(input: {
  originalType?: string
  mimeType?: string
  bytes?: number
}): JsonValue {
  return {
    type: 'multimodal_content_omitted',
    ...(input.originalType ? { originalType: input.originalType } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
  }
}

/** Replaces embedded data URLs with bounded textual placeholders for transcript safety. */
export function omitMultimodalContent(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    const match = value.match(DATA_URL)
    if (!match) return value
    const payload = value.slice(match[0].length)
    return `[multimodal content omitted: ${match[1]}, approximately ${Math.floor((payload.length * 3) / 4)} bytes]`
  }
  if (Array.isArray(value)) return value.map(omitMultimodalContent)
  if (!value || typeof value !== 'object') return value

  const type = typeof value.type === 'string' ? value.type : undefined
  const mimeType =
    typeof value.mimeType === 'string'
      ? value.mimeType
      : typeof value.mime_type === 'string'
        ? value.mime_type
        : undefined
  const encoded =
    typeof value.data === 'string'
      ? value.data
      : typeof value.base64 === 'string'
        ? value.base64
        : undefined
  if (
    (type && MULTIMODAL_TYPE.test(type)) ||
    (mimeType && MULTIMODAL_MIME.test(mimeType) && encoded)
  ) {
    return mediaPlaceholder({
      originalType: type,
      mimeType,
      ...(encoded
        ? { bytes: Math.floor((encoded.replace(/=+$/u, '').length * 3) / 4) }
        : {}),
    })
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      omitMultimodalContent(item),
    ]),
  )
}

function entry(
  event: TraceEvent,
  suffix: string,
  value: Omit<SessionTranscriptEntry, 'id' | 'seq' | 'ts'>,
): SessionTranscriptEntry {
  return {
    id: `${event.eventId}:${suffix}`,
    seq: event.seq,
    ts: event.ts,
    ...value,
  }
}

function runtimeEntry(
  event: TraceEvent,
  title: string,
  data?: JsonValue,
): SessionTranscriptEntry {
  return entry(event, event.type, {
    kind: event.type.startsWith('run.') ? 'run' : 'runtime',
    categories: ['runtime'],
    title,
    ...('runId' in event ? { runId: event.runId } : {}),
    ...(data !== undefined ? { data } : {}),
  })
}

function toolEntry(aggregate: ToolAggregate): SessionTranscriptEntry {
  const source =
    aggregate.proposed ??
    aggregate.approval ??
    aggregate.attempt ??
    aggregate.call
  if (!source) throw new Error('Tool aggregate has no source event')
  const callId = source.callId
  const tool =
    aggregate.call?.tool ??
    aggregate.attempt?.tool ??
    aggregate.proposed?.tool ??
    'unknown'
  const categories: SessionTranscriptEntry['categories'] = aggregate.approval
    ? ['tool', 'approval']
    : ['tool']
  return entry(source, `tool:${callId}`, {
    kind: 'tool',
    categories,
    title: `${tool} · ${aggregate.attempt?.outcome ?? 'proposed'}`,
    runId: source.runId,
    callId,
    data: omitMultimodalContent(
      jsonClone({
        tool,
        reason: aggregate.proposed?.reason ?? aggregate.call?.reason ?? '',
        args: aggregate.call?.args ?? aggregate.proposed?.args ?? null,
        result: aggregate.call?.result ?? null,
        approvedBy: aggregate.call?.approvedBy ?? 'none',
        policySignals: aggregate.call?.policySignals ?? [],
        diffHash: aggregate.call?.diffHash ?? null,
        stage: aggregate.attempt?.stage ?? null,
        outcome: aggregate.attempt?.outcome ?? null,
        effects: aggregate.attempt?.effects ?? [],
        durationMs:
          aggregate.attempt?.durationMs ?? aggregate.call?.durationMs ?? null,
        inputBytes: aggregate.attempt?.inputBytes ?? null,
        outputBytes: aggregate.attempt?.outputBytes ?? null,
        truncated:
          aggregate.attempt?.truncated ?? aggregate.call?.truncated ?? false,
        errorCode: aggregate.attempt?.errorCode ?? null,
        approval: aggregate.approval
          ? {
              mode: aggregate.approval.mode,
              approver: aggregate.approval.approver,
              decision: aggregate.approval.decision,
              reason: aggregate.approval.reason,
              policySignals: aggregate.approval.policySignals,
            }
          : null,
      }),
    ),
  })
}

/** Orders trace events and derives the normalized transcript document and metadata. */
export function normalizeSessionTranscript(
  events: readonly TraceEvent[],
  options: TranscriptOptions,
): SessionTranscriptDocument {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const start = ordered.find(
    (event): event is Extract<TraceEvent, { type: 'session.start' }> =>
      event.type === 'session.start',
  )
  const end = [...ordered]
    .reverse()
    .find((event) => event.type === 'session.end')
  const entries: SessionTranscriptEntry[] = []
  const tools = new Map<string, ToolAggregate>()
  const streams = new Map<string, StreamAggregate>()
  const requestMessages = new Map<string, JsonValue[]>()

  for (const event of ordered) {
    if (event.type === 'tool.proposed') {
      const aggregate = tools.get(event.callId) ?? {}
      aggregate.proposed = event
      tools.set(event.callId, aggregate)
      continue
    }
    if (event.type === 'approval') {
      const aggregate = tools.get(event.callId) ?? {}
      aggregate.approval = event
      tools.set(event.callId, aggregate)
      continue
    }
    if (event.type === 'tool.attempt') {
      const aggregate = tools.get(event.callId) ?? {}
      aggregate.attempt = event
      tools.set(event.callId, aggregate)
      continue
    }
    if (event.type === 'tool.call') {
      const aggregate = tools.get(event.callId) ?? {}
      aggregate.call = event
      tools.set(event.callId, aggregate)
      continue
    }
    if (event.type === 'llm.stream') {
      const providerEvent = event.providerEvent
      if (
        providerEvent &&
        typeof providerEvent === 'object' &&
        !Array.isArray(providerEvent) &&
        typeof providerEvent.delta === 'string'
      ) {
        const current = streams.get(event.callId) ?? {
          seq: event.seq,
          ts: event.ts,
          runId: event.runId,
          text: '',
          reasoning: '',
          completed: false,
        }
        current.seq = event.seq
        current.ts = event.ts
        if (providerEvent.type === 'text.delta') {
          current.text += providerEvent.delta
        } else if (providerEvent.type === 'reasoning.delta') {
          current.reasoning += providerEvent.delta
        }
        streams.set(event.callId, current)
      }
      continue
    }
    if (event.type === 'llm.response') {
      const stream = streams.get(event.callId)
      if (stream) stream.completed = true
      entries.push(
        entry(event, 'provider-response', {
          kind: 'provider_response',
          categories: ['provider'],
          title: 'Provider response',
          runId: event.runId,
          callId: event.callId,
          data: omitMultimodalContent(
            jsonClone({ usage: event.usage, timing: event.timing }),
          ),
        }),
      )
      continue
    }

    switch (event.type) {
      case 'session.start':
        entries.push(
          runtimeEntry(event, 'Session started', {
            workspace: event.workspace,
            model: event.model,
            mode: event.mode,
          }),
        )
        break
      case 'session.end':
        entries.push(
          runtimeEntry(
            event,
            'Session ended',
            event.reason ? { reason: event.reason } : undefined,
          ),
        )
        break
      case 'session.mode':
        entries.push(runtimeEntry(event, `Mode changed to ${event.mode}`))
        break
      case 'run.start':
        entries.push(runtimeEntry(event, 'Run started'))
        break
      case 'run.end':
        entries.push(runtimeEntry(event, `Run ended · ${event.status}`))
        break
      case 'llm.request':
        requestMessages.set(
          event.eventId,
          event.normalizedMessages.map((message) =>
            omitMultimodalContent(message),
          ),
        )
        entries.push(
          entry(event, 'provider-request', {
            kind: 'provider_request',
            categories: ['provider'],
            title: `Provider request · ${event.normalizedMessages.length} messages`,
            runId: event.runId,
            callId: event.callId,
            requestEventId: event.eventId,
            data: jsonClone({
              requestBytes: event.requestBytes,
              requestFields: event.requestFields ?? [],
              wireParameters: event.wireParameters ?? null,
              prefixHash: event.prefixHash,
              promptResources: event.promptResources ?? [],
              promptBuild: event.promptBuild ?? null,
              messageCount: event.normalizedMessages.length,
            }),
          }),
        )
        break
      case 'llm.usage':
        entries.push(
          entry(event, 'usage', {
            kind: 'usage',
            categories: ['provider'],
            title: `LLM usage · ${event.usage.scope}`,
            runId: event.runId,
            callId: event.callId,
            data: jsonClone(event.usage),
          }),
        )
        break
      case 'llm.failure':
        entries.push(
          entry(event, 'provider-failure', {
            kind: 'provider_response',
            categories: ['provider'],
            title: `Provider failure · ${event.code}`,
            runId: event.runId,
            callId: event.callId,
            data: jsonClone({
              operation: event.operation,
              stage: event.stage,
              code: event.code,
              diagnosticId: event.diagnosticId ?? null,
              message: event.message,
              httpStatus: event.httpStatus ?? null,
              providerErrorCode: event.providerErrorCode ?? null,
              retryAfterMs: event.retryAfterMs ?? null,
              requestId: event.requestId ?? null,
              timing: event.timing ?? null,
              evidence: event.evidence
                ? {
                    kind: event.evidence.kind,
                    observedBytes: event.evidence.observedBytes,
                    capturedBytes: event.evidence.capturedBytes,
                    truncated: event.evidence.truncated,
                    sha256: event.evidence.sha256,
                  }
                : null,
            }),
          }),
        )
        break
      case 'user.message':
        entries.push(
          entry(event, 'user', {
            kind: 'user',
            categories: ['user'],
            title: 'User message',
            ...(event.runId ? { runId: event.runId } : {}),
            text: event.text,
          }),
        )
        break
      case 'agent.message':
        if (event.reasoning) {
          entries.push(
            entry(event, 'reasoning', {
              kind: 'reasoning',
              categories: ['reasoning'],
              title: 'Assistant reasoning',
              ...(event.runId ? { runId: event.runId } : {}),
              text: event.reasoning,
            }),
          )
        }
        if (event.text) {
          entries.push(
            entry(event, 'assistant', {
              kind: 'assistant',
              categories: ['assistant'],
              title: 'Assistant message',
              ...(event.runId ? { runId: event.runId } : {}),
              text: event.text,
            }),
          )
        }
        break
      case 'orchestrator.message':
        entries.push(
          entry(event, 'orchestrator', {
            kind: 'orchestrator',
            categories: ['internal'],
            title: `Orchestrator · ${event.kind}`,
            runId: event.runId,
            text: event.text,
            data: jsonClone({
              kind: event.kind,
              promptId: event.promptId ?? null,
              promptHash: event.promptHash ?? null,
            }),
          }),
        )
        break
      case 'interjection.message':
        entries.push(
          entry(event, 'interjection', {
            kind: 'interjection',
            categories: ['user', 'internal'],
            title: `Interjection · ${event.status}`,
            runId: event.runId,
            text: event.content,
            data: jsonClone({
              interjectionId: event.interjectionId,
              createdAt: event.createdAt,
              injectedAfterToolBatchId: event.injectedAfterToolBatchId ?? null,
            }),
          }),
        )
        break
      case 'plan.status':
        entries.push(
          entry(event, 'plan', {
            kind: 'plan',
            categories: ['internal'],
            title: `Plan · ${event.previousStatus} → ${event.status}`,
            data: omitMultimodalContent(
              jsonClone({ source: event.source, plan: event.plan }),
            ),
          }),
        )
        break
      case 'terminal.event':
        entries.push(
          entry(event, 'terminal', {
            kind: 'terminal',
            categories: ['terminal'],
            title: `Terminal · ${event.direction}`,
            data: omitMultimodalContent(
              jsonClone({ terminalId: event.terminalId, data: event.data }),
            ),
          }),
        )
        break
    }
  }

  entries.push(...[...tools.values()].map(toolEntry))
  for (const [callId, stream] of streams) {
    if (stream.completed || (!stream.text && !stream.reasoning)) continue
    if (stream.reasoning) {
      entries.push({
        id: `partial:${callId}:reasoning`,
        seq: stream.seq,
        ts: stream.ts,
        kind: 'reasoning',
        categories: ['reasoning'],
        title: 'Assistant reasoning · partial',
        runId: stream.runId,
        callId,
        text: stream.reasoning,
        partial: true,
      })
    }
    if (stream.text) {
      entries.push({
        id: `partial:${callId}:assistant`,
        seq: stream.seq,
        ts: stream.ts,
        kind: 'assistant',
        categories: ['assistant'],
        title: 'Assistant message · partial',
        runId: stream.runId,
        callId,
        text: stream.text,
        partial: true,
      })
    }
  }

  entries.sort((left, right) =>
    left.seq === right.seq
      ? left.id.localeCompare(right.id)
      : left.seq - right.seq,
  )
  const lastSeq = ordered.at(-1)?.seq ?? 0
  return {
    metadata: {
      schemaVersion: SESSION_TRANSCRIPT_SCHEMA_VERSION,
      format: SESSION_TRANSCRIPT_FORMAT,
      importable: false,
      classification: 'restricted',
      traceId: options.traceId,
      revision: options.revision,
      ...(start
        ? {
            sessionId: start.sessionId,
            workspace: start.workspace,
            model: start.model,
            mode: start.mode,
            startedAt: start.ts,
          }
        : {}),
      ...(end ? { endedAt: end.ts } : {}),
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      lastSeq,
      active: options.active ?? !end,
    },
    entries,
    requestMessages,
  }
}

function yamlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value ?? '')
}

function safeFence(content: string, language = ''): string {
  const runs = content.match(/`+/gu) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${content}\n${fence}`
}

function renderEntry(
  item: SessionTranscriptEntry,
  requestMessages: ReadonlyMap<string, JsonValue[]>,
): string {
  const heading = `## #${item.seq} · ${item.ts} · ${item.title}`
  const labels = [
    `kind: ${item.kind}`,
    `categories: ${item.categories.join(', ')}`,
    ...(item.runId ? [`run: ${item.runId}`] : []),
    ...(item.callId ? [`call: ${item.callId}`] : []),
    ...(item.partial ? ['partial: true'] : []),
  ].join(' · ')
  const parts = [heading, labels]
  if (item.text !== undefined) parts.push(safeFence(item.text, 'text'))
  if (item.data !== undefined) {
    parts.push(safeFence(JSON.stringify(item.data, null, 2), 'json'))
  }
  if (item.requestEventId) {
    const messages = requestMessages.get(item.requestEventId) ?? []
    parts.push(
      [
        '<details>',
        `<summary>Provider context snapshot · ${messages.length} messages</summary>`,
        '',
        safeFence(JSON.stringify(messages, null, 2), 'json'),
        '',
        '</details>',
      ].join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** Renders a normalized session transcript document as bounded Markdown. */
export function sessionTranscriptToMarkdown(
  document: SessionTranscriptDocument,
): string {
  const metadata = document.metadata
  const frontMatter = [
    '---',
    ...Object.entries(metadata).map(
      ([key, value]) => `${key}: ${yamlValue(value)}`,
    ),
    '---',
  ]
  const warning = [
    '> [!WARNING]',
    '> This restricted local export may contain source code, file paths, commands,',
    '> tool arguments/results, internal orchestration, and plaintext reasoning.',
    '> It has not been scanned or redacted for sensitive information. Store and share it responsibly.',
  ].join('\n')
  return `${frontMatter.join('\n')}\n\n${warning}\n\n# Session transcript\n\n${document.entries
    .map((item) => renderEntry(item, document.requestMessages))
    .join('\n\n')}\n`
}
