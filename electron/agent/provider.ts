import type { JsonValue } from '../../shared/json'
import type { ToolCall } from '../tools/types'

export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ProviderMessage {
  role: ProviderRole
  content?: string | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: JsonValue[]
}

export interface ProviderAssistantTurn extends ProviderMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: JsonValue[]
}

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
      turn: ProviderAssistantTurn
      toolCalls: ToolCall[]
      usage: JsonValue
      providerState: JsonValue
      timing: JsonValue
    }

export interface ProviderRequestSnapshot {
  normalizedMessages: JsonValue[]
  providerRequest: JsonValue
  requestBytes: number
  prefixHash: string
  prefixFingerprints?: string[]
}

export interface ProviderChatRequest {
  messages: ProviderMessage[]
  tools: JsonValue[]
  providerRequestOverride?: JsonValue
  signal: AbortSignal
  onRequest?: (snapshot: ProviderRequestSnapshot) => Promise<void> | void
}

export interface LLMProvider {
  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderEvent>
}
