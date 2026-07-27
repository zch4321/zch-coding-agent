import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'

export class ScriptedProvider extends ScriptedProviderHarness {
  calls = 0
  requestBodies: JsonValue[] = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requestBodies.push(structuredClone(request.providerRequest ?? null))
    await request.onRequest?.({
      normalizedMessages: request.normalizedMessages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.normalizedMessages as unknown as JsonValue[],
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
        rawResponse: { id: 'first', echo: 'secret-sentinel' },
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
        providerState: { turn: 1, echo: 'secret-sentinel' },
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
      rawResponse: { id: 'second', echo: 'secret-sentinel' },
      turn: { role: 'assistant', content: 'README summary' },
      toolCalls: [],
      usage: { total_tokens: 12 },
      providerState: { turn: 2, echo: 'secret-sentinel' },
      timing: { ttftMs: 1, totalMs: 2 },
    }
  }
}

export class PromptAuditProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    await request.onRequest?.({
      normalizedMessages: request.normalizedMessages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.normalizedMessages as unknown as JsonValue[],
        tools: request.toolDefinitions as unknown as JsonValue[],
      } as JsonValue,
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
