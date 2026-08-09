import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderType } from '../../shared/config'
import {
  assertBoundedJsonValue,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import type {
  MessagePart,
  MessageRecord,
  ProviderCompactEnvelope,
  ProviderContinuationEnvelope,
} from '../../shared/message'
import {
  areModelRoutesHistoryCompatible,
  type ModelRouteSnapshot,
} from '../../shared/model-route'
import type { CompiledCanonicalHistory } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'

/** Provider-neutral tool metadata compiled into one provider's wire schema. */
export interface ProviderToolDefinition {
  name: string
  description: string
  inputSchema: JsonValue
  intentParameter: string
}

/** Provider-neutral structured text output requested by trusted runtime code. */
export type ProviderStructuredOutput =
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: JsonObject }

/** Canonical input required to compile one provider request without I/O. */
export interface ProviderCompileInput {
  history: CompiledCanonicalHistory
  route: ModelRouteSnapshot
  tools: ProviderToolDefinition[]
  maxOutputTokens: number
  structuredOutput?: ProviderStructuredOutput
}

/** Deterministic, credential-free provider request ready for tracing and streaming. */
export interface CompiledProviderCall {
  request: JsonObject
  normalizedMessages: JsonObject[]
  tools: ProviderToolDefinition[]
}

/** Canonical history and controls required for one Provider compaction. */
export interface ProviderCompactInput {
  history: CompiledCanonicalHistory
  route: ModelRouteSnapshot
  instructions: string
  maxOutputTokens: number
}

/** Deterministic Provider compaction request ready for tracing and execution. */
export interface CompiledProviderCompactCall {
  mode: 'native' | 'synthetic'
  request: JsonObject
  normalizedMessages: JsonObject[]
}

/** Runtime-only controls used while sending one compiled provider request. */
export interface ProviderStreamContext {
  signal: AbortSignal
}

/** Normalized token metrics plus the exact provider-native usage payload. */
export interface ProviderUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  raw: JsonValue
}

/** Canonical assistant turn produced by a completed provider stream. */
export interface CompletedAssistantTurn {
  parts: MessagePart[]
  toolCalls: ToolCall[]
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  usage: ProviderUsage
  finishReason: string
}

/** Provider-neutral result of an opaque or synthetic history compaction. */
export interface CompletedProviderCompact {
  payload: ProviderCompactEnvelope
  normalizedText?: string
  usage: ProviderUsage
}

/** Bounded timing metrics recorded for one provider request. */
export interface ProviderTiming {
  ttftMs: number | null
  totalMs: number
  responseBytes: number
}

/** Redactable response evidence retained when a Provider cannot form a canonical completion. */
export interface ProviderResponseDiagnostics {
  rawResponse: JsonValue
  providerState: JsonValue
  usage: JsonValue
  timing: ProviderTiming
}

/** Reports a response-level completion failure while preserving trace diagnostics. */
export class ProviderCompletionError extends TypeError {
  readonly diagnostics: ProviderResponseDiagnostics

  constructor(
    message: string,
    diagnostics: ProviderResponseDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProviderCompletionError'
    this.diagnostics = structuredClone(diagnostics)
  }
}

export type ProviderCompactCompletionFailure =
  | 'incomplete'
  | 'rejected'
  | 'invalid'

/** Reports why a complete synthetic compact response cannot become a checkpoint. */
export class ProviderCompactCompletionError extends ProviderCompletionError {
  readonly failure: ProviderCompactCompletionFailure

  constructor(
    message: string,
    failure: ProviderCompactCompletionFailure,
    diagnostics: ProviderResponseDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, diagnostics, options)
    this.name = 'ProviderCompactCompletionError'
    this.failure = failure
  }
}

/** Events emitted while executing one compiled provider request. */
export type ProviderEvent =
  | {
      type: 'text.delta'
      delta: string
      raw: JsonValue
    }
  | {
      type: 'reasoning.delta'
      delta: string
      raw: JsonValue
    }
  | {
      type: 'tool.delta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
      raw: JsonValue
    }
  | {
      type: 'completed'
      turn: CompletedAssistantTurn
      rawResponse: JsonValue
      providerState: JsonValue
      timing: ProviderTiming
    }

/** Events emitted while executing a Provider compaction. */
export type ProviderCompactEvent =
  | {
      type: 'text.delta'
      delta: string
      raw: JsonValue
    }
  | {
      type: 'completed'
      compact: CompletedProviderCompact
      rawResponse: JsonValue
      providerState: JsonValue
      timing: ProviderTiming
    }

/** Flat provider boundary used by main, compact, and approval model calls. */
export interface ModelProvider {
  readonly providerType: ProviderType
  compile(input: ProviderCompileInput): CompiledProviderCall
  stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent>
  compileCompact(input: ProviderCompactInput): CompiledProviderCompactCall
  compact(
    call: CompiledProviderCompactCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderCompactEvent>
}

/** Adapts a regular no-tools Provider call into a synthetic compact call. */
export function compiledSyntheticCompactCall(
  call: CompiledProviderCall,
  instructions: string,
): CompiledProviderCompactCall {
  const normalizedMessages = [
    ...structuredClone(call.normalizedMessages),
    { role: 'user', content: instructions },
  ]
  return {
    mode: 'synthetic',
    request: {
      ...structuredClone(call.request),
      messages: structuredClone(normalizedMessages),
    },
    normalizedMessages,
  }
}

/** Converts a normal no-tools provider stream into a versioned text compact envelope. */
export async function* syntheticCompactEvents(
  providerType: ProviderType,
  events: AsyncIterable<ProviderEvent>,
): AsyncIterable<ProviderCompactEvent> {
  let streamedText = ''
  let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined
  for await (const event of events) {
    if (event.type === 'text.delta') {
      streamedText += event.delta
      yield event
    } else if (event.type === 'completed') {
      if (completed) {
        throw new ProviderCompactCompletionError(
          'Provider compact produced multiple completions',
          'invalid',
          providerCompletionDiagnostics(event),
        )
      }
      completed = event
    }
  }
  if (!completed) {
    throw new TypeError('Provider compact stream ended without completion')
  }
  const diagnostics = providerCompletionDiagnostics(completed)
  try {
    assertCompletedAssistantTurn(completed.turn)
  } catch (error) {
    throw new ProviderCompactCompletionError(
      'Provider compact returned an invalid assistant turn',
      'invalid',
      diagnostics,
      { cause: error },
    )
  }
  if (completed.turn.finishReason !== 'completed') {
    throw new ProviderCompactCompletionError(
      `Provider compact did not complete successfully (${completed.turn.finishReason})`,
      completed.turn.finishReason === 'truncated' ? 'incomplete' : 'rejected',
      diagnostics,
    )
  }
  if (completed.turn.toolCalls.length > 0) {
    throw new ProviderCompactCompletionError(
      'Provider compact returned tool calls',
      'invalid',
      diagnostics,
    )
  }
  const text = (
    streamedText ||
    completed.turn.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
  ).trim()
  if (!text) {
    throw new ProviderCompactCompletionError(
      'Provider compact summary was empty',
      'invalid',
      diagnostics,
    )
  }
  yield {
    type: 'completed',
    compact: {
      payload: {
        schemaVersion: 1,
        providerType,
        format: 'summary-text.v1',
        data: { text },
      },
      normalizedText: text,
      usage: structuredClone(completed.turn.usage),
    },
    rawResponse: structuredClone(completed.rawResponse),
    providerState: structuredClone(completed.providerState),
    timing: structuredClone(completed.timing),
  }
}

/** Validates an opaque compact record before a Provider attempts to replay it. */
export function providerCompactPayload(
  record: Extract<MessageRecord, { kind: 'compact_summary' }>,
  route: ModelRouteSnapshot,
): ProviderCompactEnvelope | undefined {
  const part = record.parts[0]
  if (part?.type !== 'provider_compact') return undefined
  if (!('modelRoute' in record)) {
    throw new TypeError('Provider compact record is missing its model route')
  }
  if (!areModelRoutesHistoryCompatible(record.modelRoute, route)) {
    throw new TypeError(
      'Provider compact history is incompatible with this route',
    )
  }
  if (part.payload.providerType !== route.providerType) {
    throw new TypeError('Provider compact payload belongs to another Provider')
  }
  assertBoundedJsonValue(part.payload.data)
  return part.payload
}

/** Renders legacy and synthetic text checkpoints for text-based Provider protocols. */
export function providerCompactText(
  record: Extract<MessageRecord, { kind: 'compact_summary' }>,
  route: ModelRouteSnapshot,
): string {
  const payload = providerCompactPayload(record, route)
  if (!payload) {
    return record.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
  }
  if (payload.format !== 'summary-text.v1') {
    throw new TypeError(
      `Provider compact format is not text-compatible: ${payload.format}`,
    )
  }
  const data = payload.data
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.text !== 'string' ||
    !data.text.trim()
  ) {
    throw new TypeError('Provider compact text payload is corrupt')
  }
  return `<compact_history>\n${data.text.trim()}\n</compact_history>`
}

/** Validates the canonical completion boundary and tool-call part consistency. */
export function assertCompletedAssistantTurn(
  value: unknown,
): asserts value is CompletedAssistantTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provider completion must be an object')
  }
  const completed = value as Partial<CompletedAssistantTurn>
  if (
    !Array.isArray(completed.parts) ||
    !Array.isArray(completed.toolCalls) ||
    typeof completed.finishReason !== 'string' ||
    !completed.usage ||
    typeof completed.usage !== 'object' ||
    Array.isArray(completed.usage) ||
    !('raw' in completed.usage)
  ) {
    throw new TypeError('Provider completion is missing canonical fields')
  }
  assertBoundedJsonValue(completed.parts)
  assertBoundedJsonValue(completed.toolCalls)
  assertBoundedJsonValue(completed.usage.raw)

  const toolParts = completed.parts.filter(
    (part): part is Extract<MessagePart, { type: 'tool_call' }> =>
      Boolean(part && typeof part === 'object' && part.type === 'tool_call'),
  )
  if (toolParts.length !== completed.toolCalls.length) {
    throw new TypeError(
      'Provider completion parts do not match normalized tool calls',
    )
  }
  for (const [index, call] of completed.toolCalls.entries()) {
    const part = toolParts[index]!
    if (
      !call ||
      typeof call !== 'object' ||
      part.callId !== call.id ||
      part.name !== call.toolId ||
      !isDeepStrictEqual(part.arguments, call.args)
    ) {
      throw new TypeError(
        'Provider completion parts do not match normalized tool calls',
      )
    }
  }
}

function jsonValueOrNull(value: unknown): JsonValue {
  try {
    assertBoundedJsonValue(value)
    return structuredClone(value)
  } catch {
    return null
  }
}

/** Extracts non-throwing failure diagnostics from a completed Provider event. */
export function providerCompletionDiagnostics(
  event: Extract<ProviderEvent, { type: 'completed' }>,
): ProviderResponseDiagnostics {
  const candidate = event as unknown as Record<string, unknown>
  const turn =
    candidate.turn &&
    typeof candidate.turn === 'object' &&
    !Array.isArray(candidate.turn)
      ? (candidate.turn as Record<string, unknown>)
      : undefined
  const usage =
    turn?.usage && typeof turn.usage === 'object' && !Array.isArray(turn.usage)
      ? (turn.usage as Record<string, unknown>).raw
      : null
  const timing =
    candidate.timing &&
    typeof candidate.timing === 'object' &&
    !Array.isArray(candidate.timing)
      ? (candidate.timing as Record<string, unknown>)
      : {}
  return {
    rawResponse: jsonValueOrNull(candidate.rawResponse),
    providerState: jsonValueOrNull(candidate.providerState),
    usage: jsonValueOrNull(usage),
    timing: {
      ttftMs:
        timing.ttftMs === null ||
        (typeof timing.ttftMs === 'number' && Number.isFinite(timing.ttftMs))
          ? timing.ttftMs
          : null,
      totalMs:
        typeof timing.totalMs === 'number' && Number.isFinite(timing.totalMs)
          ? timing.totalMs
          : 0,
      responseBytes:
        typeof timing.responseBytes === 'number' &&
        Number.isFinite(timing.responseBytes)
          ? timing.responseBytes
          : 0,
    },
  }
}

/** Computes stable, credential-free diagnostics for a compiled provider call. */
export function providerRequestDiagnostics(
  call: Pick<CompiledProviderCall, 'request' | 'normalizedMessages'>,
): {
  requestBytes: number
  prefixHash: string
} {
  return {
    requestBytes: Buffer.byteLength(JSON.stringify(call.request), 'utf8'),
    prefixHash: createHash('sha256')
      .update(JSON.stringify(call.normalizedMessages))
      .digest('hex'),
  }
}
