import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'

export class ScriptedProvider implements LLMProvider {
  calls = 0

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
      },
      requestBytes: 10,
      prefixHash: `fixture-${this.calls}`,
    })

    if (this.calls === 1) {
      yield {
        type: 'reasoning.delta',
        delta: 'Need README.',
        raw: { type: 'reasoning.delta' },
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'first' },
        turn: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Need README.',
          tool_calls: [
            {
              id: 'call-readme',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-readme' as CallId,
            toolId: 'read_file',
            args: { path: 'README.md' },
            reason: '',
          },
        ],
        usage: { total_tokens: 8 },
        providerState: { turn: 1 },
        timing: { ttftMs: 1, totalMs: 2 },
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'README summary',
      raw: { type: 'text.delta' },
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'second' },
      turn: { role: 'assistant', content: 'README summary' },
      toolCalls: [],
      usage: { total_tokens: 12 },
      providerState: { turn: 2 },
      timing: { ttftMs: 1, totalMs: 2 },
    }
  }
}

export class PromptAuditProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
        tools: request.tools,
      },
      requestBytes: 10,
      prefixHash: `prompt-audit-${this.calls}`,
    })
    yield {
      type: 'completed',
      rawResponse: { id: 'prompt-audit' },
      turn: { role: 'assistant', content: 'Prompt audit complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}
