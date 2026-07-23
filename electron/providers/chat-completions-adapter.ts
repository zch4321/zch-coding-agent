import type { JsonObject, JsonValue } from '../../shared/json'
import type {
  MessagePart,
  MessageRecord,
  ToolCallPart,
} from '../../shared/message'
import { canonicalHash, messageText } from '../session/canonical-history'
import type {
  AdapterCompileInput,
  ChatCompletionsRequestDto,
  CompletedAssistantTurn,
  ProviderProtocolAdapter,
} from './provider-protocol'
import type {
  ProviderAssistantTurn,
  ProviderEvent,
  ProviderMessage,
} from './provider'

const CONTINUATION_FORMAT = 'chat-completions.assistant.v1'

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function nativeToolCalls(parts: readonly ToolCallPart[]): JsonValue[] {
  return parts.map((part) => ({
    id: part.callId,
    type: 'function',
    function: {
      name: part.name,
      arguments: JSON.stringify(part.arguments),
    },
  }))
}

function wireTools(tools: JsonValue[]): JsonValue[] {
  return tools.map((candidate) => {
    const cloned = structuredClone(candidate)
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
      return cloned
    }
    const fn = cloned.function
    if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
      delete fn['x-agent-intent-property']
    }
    return cloned
  })
}

function canonicalAssistant(
  record: Extract<
    MessageRecord,
    {
      kind: 'assistant_turn'
    }
  >,
): ProviderAssistantTurn {
  const calls = record.parts.filter(
    (part): part is ToolCallPart => part.type === 'tool_call',
  )
  const content = messageText(record)
  return {
    role: 'assistant',
    content: content || null,
    ...(record.normalizedReasoningText
      ? { reasoning_content: record.normalizedReasoningText }
      : {}),
    ...(calls.length > 0 ? { tool_calls: nativeToolCalls(calls) } : {}),
  }
}

function continuationAssistant(
  adapterId: string,
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): ProviderAssistantTurn | undefined {
  const continuation = record.providerContinuation
  if (
    !continuation ||
    continuation.adapterId !== adapterId ||
    continuation.format !== CONTINUATION_FORMAT
  ) {
    return undefined
  }
  const data = continuation.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Chat continuation payload is corrupt')
  }
  if (data.partsHash !== canonicalHash(record.parts)) return undefined
  const assistant = data.assistant
  if (
    !assistant ||
    typeof assistant !== 'object' ||
    Array.isArray(assistant) ||
    assistant.role !== 'assistant' ||
    !('content' in assistant)
  ) {
    throw new TypeError('Chat continuation assistant payload is corrupt')
  }
  return structuredClone(assistant) as unknown as ProviderAssistantTurn
}

function compileMessage(
  adapterId: string,
  record: MessageRecord,
): ProviderMessage[] {
  switch (record.kind) {
    case 'system_instruction':
      return [{ role: 'system', content: messageText(record) }]
    case 'assistant_turn':
      return [
        continuationAssistant(adapterId, record) ?? canonicalAssistant(record),
      ]
    case 'tool_result': {
      const result = record.parts[0]
      return [
        {
          role: 'tool',
          tool_call_id: result.callId,
          content: JSON.stringify(result.content),
        },
      ]
    }
    default:
      return [{ role: 'user', content: messageText(record) }]
  }
}

export class ChatCompletionsAdapter implements ProviderProtocolAdapter<ChatCompletionsRequestDto> {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  compile(input: AdapterCompileInput): ChatCompletionsRequestDto {
    if (input.route.adapterId !== this.id) {
      throw new TypeError(
        `Route adapter ${input.route.adapterId} does not match ${this.id}`,
      )
    }
    const messages = input.history.messages.flatMap((record) =>
      compileMessage(this.id, record),
    )
    const tools = structuredClone(input.tools)
    const providerTools = wireTools(tools)
    const deepSeek = this.id === 'deepseek.chat-completions'
    const body = toJsonValue({
      model: input.route.model,
      messages,
      ...(providerTools.length > 0 ? { tools: providerTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(input.responseFormat
        ? { response_format: toJsonValue(input.responseFormat) }
        : {}),
      ...(deepSeek
        ? {
            thinking: {
              type: input.route.reasoning === 'off' ? 'disabled' : 'enabled',
            },
            ...(input.route.reasoning === 'off'
              ? {}
              : { reasoning_effort: input.route.reasoning }),
          }
        : {}),
    }) as JsonObject
    return {
      body,
      messages,
      tools,
      ...(input.responseFormat
        ? { responseFormat: structuredClone(input.responseFormat) }
        : {}),
    }
  }

  complete(
    event: Extract<ProviderEvent, { type: 'completed' }>,
    streamed: { text: string; reasoning: string } = {
      text: '',
      reasoning: '',
    },
  ): CompletedAssistantTurn {
    const turn: ProviderAssistantTurn = {
      ...event.turn,
      content: event.turn.content || streamed.text || null,
      ...(event.turn.reasoning_content || streamed.reasoning
        ? {
            reasoning_content:
              event.turn.reasoning_content || streamed.reasoning,
          }
        : {}),
    }
    const parts: MessagePart[] = []
    if (turn.content) parts.push({ type: 'text', text: turn.content })
    for (const call of event.toolCalls) {
      parts.push({
        type: 'tool_call',
        callId: call.id,
        name: call.toolId,
        arguments: structuredClone(call.args),
      })
    }
    if (parts.length === 0) {
      throw new TypeError('Provider completed with an empty assistant turn')
    }
    return {
      parts,
      toolCalls: structuredClone(event.toolCalls),
      ...(turn.reasoning_content
        ? { normalizedReasoningText: turn.reasoning_content }
        : {}),
      providerContinuation: {
        schemaVersion: 1,
        adapterId: this.id,
        format: CONTINUATION_FORMAT,
        data: {
          partsHash: canonicalHash(parts),
          assistant: toJsonValue(turn),
        },
      },
      usage: structuredClone(event.usage),
      finishReason: event.toolCalls.length > 0 ? 'tool_calls' : 'completed',
    }
  }
}

export function chatAdapter(adapterId: string): ChatCompletionsAdapter {
  if (
    adapterId !== 'deepseek.chat-completions' &&
    adapterId !== 'openai-compatible.chat-completions'
  ) {
    throw new TypeError(`Unsupported Provider adapter: ${adapterId}`)
  }
  return new ChatCompletionsAdapter(adapterId)
}
