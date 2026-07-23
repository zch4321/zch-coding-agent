import type { JsonValue } from '../../shared/json'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'

function deferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { resolve, promise }
}

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

export class AbortCompactProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []
  compactStarted = deferred()

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (request.tools.length === 0) {
      yield { type: 'text.delta', delta: 'partial summary', raw: {} }
      this.compactStarted.resolve()
      await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason ?? new Error('aborted')),
          { once: true },
        )
      })
    }

    yield {
      type: 'completed',
      rawResponse: { id: `main-${this.calls}` },
      turn: { role: 'assistant', content: `Main response ${this.calls}` },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class InterjectedAutoCompactProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []
  compactStarted = deferred()
  releaseCompact = deferred()

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (request.tools.length === 0) {
      this.compactStarted.resolve()
      await this.releaseCompact.promise
      yield {
        type: 'completed',
        rawResponse: { id: 'interjected-compact' },
        turn: {
          role: 'assistant',
          content: 'Interjected compact summary retained',
        },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'interjected-main' },
      turn: { role: 'assistant', content: 'Handled latest interjection' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}
