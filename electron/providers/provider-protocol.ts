import type { JsonObject, JsonValue } from '../../shared/json'
import type {
  MessagePart,
  ProviderContinuationEnvelope,
} from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { CompiledCanonicalHistory } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'
import type {
  ProviderEvent,
  ProviderMessage,
  ProviderResponseFormat,
} from './provider'

export interface AdapterCompileInput {
  history: CompiledCanonicalHistory
  route: ModelRouteSnapshot
  tools: JsonValue[]
  responseFormat?: ProviderResponseFormat
}

export interface ChatCompletionsRequestDto {
  body: JsonObject
  messages: ProviderMessage[]
  tools: JsonValue[]
  responseFormat?: ProviderResponseFormat
}

export interface CompletedAssistantTurn {
  parts: MessagePart[]
  toolCalls: ToolCall[]
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  usage: JsonValue
  finishReason: string
}

export interface ProviderProtocolAdapter<RequestDto> {
  readonly id: string
  compile(input: AdapterCompileInput): RequestDto
  complete(
    event: Extract<ProviderEvent, { type: 'completed' }>,
    streamed?: { text: string; reasoning: string },
  ): CompletedAssistantTurn
}
