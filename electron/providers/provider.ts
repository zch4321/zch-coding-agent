import type { JsonObject, JsonValue } from '../../shared/json'
import type { ToolCall } from '../tools/types'

/** Events emitted by a provider transport while executing one compiled request. */
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
      type: 'usage'
      usage: JsonValue
      raw: JsonValue
    }
  | {
      type: 'completed'
      rawResponse: JsonValue
      turn: JsonValue
      toolCalls: ToolCall[]
      usage: JsonValue
      finishReason?: string
      providerState: JsonValue
      timing: JsonValue
    }

/** Bounded diagnostics captured immediately before a provider request is sent. */
export interface ProviderRequestSnapshot {
  normalizedMessages: JsonValue[]
  providerRequest: JsonValue
  requestBytes: number
  prefixHash: string
}

/** Opaque protocol request passed from an adapter to its streaming transport. */
export interface ProviderStreamRequest {
  providerRequest: JsonObject
  normalizedMessages: JsonObject[]
  toolDefinitions: JsonValue[]
  signal: AbortSignal
  onRequest?: (snapshot: ProviderRequestSnapshot) => Promise<void> | void
}

/** Protocol-neutral streaming boundary used by the agent runtime. */
export interface LLMProvider {
  stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent>
}
