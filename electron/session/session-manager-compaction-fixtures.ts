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

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'old-run' },
        turn: { role: 'assistant', content: 'Old answer' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2) {
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
      rawResponse: { id: 'after-compact' },
      turn: { role: 'assistant', content: 'After compact' },
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

    if (this.calls === 2) {
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
