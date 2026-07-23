import type { JsonValue } from '../../shared/json'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'

export class CompactProvider implements LLMProvider {
  calls = 0
  requests: Array<{
    messages: ProviderChatRequest['messages']
    tools: ProviderChatRequest['tools']
  }> = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
        tools: request.tools,
      },
      requestBytes: 10,
      prefixHash: `compact-${this.calls}`,
    })

    if (request.tools.length === 0) {
      yield {
        type: 'completed',
        rawResponse: { id: 'compact' },
        turn: { role: 'assistant', content: 'Compact summary retained' },
        toolCalls: [],
        usage: { total_tokens: 7 },
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: `main-${this.calls}` },
      turn: {
        role: 'assistant',
        content: this.calls === 1 ? 'Old answer' : 'After compact',
      },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class AutoCompactProvider implements LLMProvider {
  calls = 0
  requests: Array<{
    messages: ProviderChatRequest['messages']
    tools: ProviderChatRequest['tools']
  }> = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
        tools: request.tools,
      },
      requestBytes: 10,
      prefixHash: `auto-compact-${this.calls}`,
    })

    if (request.tools.length === 0) {
      yield {
        type: 'completed',
        rawResponse: { id: 'auto-compact' },
        turn: { role: 'assistant', content: 'Auto compact summary retained' },
        toolCalls: [],
        usage: { total_tokens: 9 },
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: `normal-${this.calls}` },
      turn: { role: 'assistant', content: `Normal response ${this.calls}` },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}
