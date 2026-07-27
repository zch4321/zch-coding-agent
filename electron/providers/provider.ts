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
  ProviderContinuationEnvelope,
} from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { CompiledCanonicalHistory } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'

/** Provider-neutral tool metadata compiled into one provider's wire schema. */
export interface ProviderToolDefinition {
  name: string
  description: string
  inputSchema: JsonValue
  intentParameter: string
}

/** Canonical input required to compile one provider request without I/O. */
export interface ProviderCompileInput {
  history: CompiledCanonicalHistory
  route: ModelRouteSnapshot
  tools: ProviderToolDefinition[]
  structuredOutput?: 'json_object'
}

/** Deterministic, credential-free provider request ready for tracing and streaming. */
export interface CompiledProviderCall {
  request: JsonObject
  normalizedMessages: JsonObject[]
  tools: ProviderToolDefinition[]
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

  constructor(message: string, diagnostics: ProviderResponseDiagnostics) {
    super(message)
    this.name = 'ProviderCompletionError'
    this.diagnostics = structuredClone(diagnostics)
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

/** Flat provider boundary used by main, compact, and approval model calls. */
export interface ModelProvider {
  readonly providerType: ProviderType
  compile(input: ProviderCompileInput): CompiledProviderCall
  stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent>
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
export function providerRequestDiagnostics(call: CompiledProviderCall): {
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
