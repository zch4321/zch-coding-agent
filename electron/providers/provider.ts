import { createHash } from 'node:crypto'
import type { ProviderType } from '../../shared/config'
import type { JsonObject, JsonValue } from '../../shared/json'
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
