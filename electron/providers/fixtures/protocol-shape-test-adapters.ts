import type { JsonValue } from '../../../shared/json'
import type { MessagePart } from '../../../shared/message'
import type {
  AdapterCompileInput,
  CompletedAssistantTurn,
  ProviderProtocolAdapter,
} from '../provider-protocol'
import type { ProviderEvent } from '../provider'

export interface ResponsesTestRequest {
  input: Array<{
    messageSeq: number
    type: string
    value: JsonValue
  }>
}

export interface AnthropicTestRequest {
  messages: Array<{
    role: 'assistant' | 'user'
    blocks: JsonValue[]
  }>
}

function complete(
  event: Extract<ProviderEvent, { type: 'completed' }>,
): CompletedAssistantTurn {
  const content =
    event.turn &&
    typeof event.turn === 'object' &&
    !Array.isArray(event.turn) &&
    typeof event.turn.content === 'string'
      ? event.turn.content
      : ''
  const parts: MessagePart[] = content
    ? [{ type: 'text', text: content }]
    : event.toolCalls.map((call) => ({
        type: 'tool_call',
        callId: call.id,
        name: call.toolId,
        arguments: structuredClone(call.args),
      }))
  return {
    parts,
    toolCalls: structuredClone(event.toolCalls),
    usage: structuredClone(event.usage),
    finishReason: event.toolCalls.length > 0 ? 'tool_calls' : 'completed',
  }
}

export class ResponsesShapeTestAdapter implements ProviderProtocolAdapter<ResponsesTestRequest> {
  readonly id = 'test.responses'

  compile(input: AdapterCompileInput): ResponsesTestRequest {
    return {
      input: input.history.messages.flatMap((message) =>
        message.parts.map((part) => ({
          messageSeq: message.seq,
          type: part.type,
          value: structuredClone(part) as JsonValue,
        })),
      ),
    }
  }

  complete(
    event: Extract<ProviderEvent, { type: 'completed' }>,
  ): CompletedAssistantTurn {
    return complete(event)
  }
}

export class AnthropicShapeTestAdapter implements ProviderProtocolAdapter<AnthropicTestRequest> {
  readonly id = 'test.anthropic'

  compile(input: AdapterCompileInput): AnthropicTestRequest {
    const messages: AnthropicTestRequest['messages'] = []
    for (const message of input.history.messages) {
      const role = message.kind === 'assistant_turn' ? 'assistant' : 'user'
      const blocks = message.parts.map(
        (part) => structuredClone(part) as JsonValue,
      )
      const previous = messages.at(-1)
      if (message.kind === 'tool_result' && previous?.role === 'user') {
        previous.blocks.push(...blocks)
      } else {
        messages.push({ role, blocks })
      }
    }
    return { messages }
  }

  complete(
    event: Extract<ProviderEvent, { type: 'completed' }>,
  ): CompletedAssistantTurn {
    return complete(event)
  }
}
