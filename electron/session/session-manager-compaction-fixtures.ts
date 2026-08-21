import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import type { CallId } from '../../shared/ids'
import { TODO_TOOL_ID } from '../../shared/todo'

function deferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { resolve, promise }
}

export class CompactProvider extends ScriptedProviderHarness {
  calls = 0
  requests: Array<{
    messages: ProviderStreamRequest['normalizedMessages']
    tools: ProviderStreamRequest['toolDefinitions']
  }> = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.normalizedMessages),
      tools: structuredClone(request.toolDefinitions),
    })

    if (request.toolDefinitions.length === 0) {
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

export class AutoCompactProvider extends ScriptedProviderHarness {
  calls = 0
  requests: Array<{
    messages: ProviderStreamRequest['normalizedMessages']
    tools: ProviderStreamRequest['toolDefinitions']
  }> = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.normalizedMessages),
      tools: structuredClone(request.toolDefinitions),
    })

    if (request.toolDefinitions.length === 0) {
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
      usage: { total_tokens: 2_000 },
      providerState: {},
      timing: {},
    }
  }
}

export class AbortCompactProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  compactStarted = deferred()

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (request.toolDefinitions.length === 0) {
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

export class InterjectedAutoCompactProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  compactStarted = deferred()
  releaseCompact = deferred()

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (request.toolDefinitions.length === 0) {
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
      usage: { total_tokens: 2_000 },
      providerState: {},
      timing: {},
    }
  }
}

export class ToolBatchAutoCompactProvider extends ScriptedProviderHarness {
  calls = 0
  requests: Array<{
    messages: ProviderStreamRequest['normalizedMessages']
    tools: ProviderStreamRequest['toolDefinitions']
  }> = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.normalizedMessages),
      tools: structuredClone(request.toolDefinitions),
    })

    if (request.toolDefinitions.length === 0) {
      yield {
        type: 'completed',
        rawResponse: { id: 'tool-batch-compact' },
        turn: {
          role: 'assistant',
          content:
            'Tool result checkpoint retained. Todo remains: Finish after compact.',
        },
        toolCalls: [],
        usage: { total_tokens: 20 },
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'tool-batch-main' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:compact-todo',
              type: 'function',
              function: {
                name: TODO_TOOL_ID,
                arguments: JSON.stringify({
                  explanation: 'Track compacted work',
                  items: [
                    { step: 'Read the fixture', status: 'in_progress' },
                    { step: 'Finish after compact', status: 'pending' },
                  ],
                  _agent_intent: 'Keep the current task checklist visible',
                }),
              },
            },
            {
              id: 'call:compact-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({
                  path: 'README.md',
                  _agent_intent: 'Inspect the fixture before compaction',
                }),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:compact-todo' as CallId,
            toolId: TODO_TOOL_ID,
            args: {
              explanation: 'Track compacted work',
              items: [
                { step: 'Read the fixture', status: 'in_progress' },
                { step: 'Finish after compact', status: 'pending' },
              ],
            },
            reason: 'Keep the current task checklist visible',
          },
          {
            id: 'call:compact-read' as CallId,
            toolId: 'read_file',
            args: { path: 'README.md' },
            reason: 'Inspect the fixture before compaction',
          },
        ],
        usage: { total_tokens: 2_000 },
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'tool-batch-finished' },
      turn: {
        role: 'assistant',
        content: 'Finished after compacting the tool.',
      },
      toolCalls: [],
      usage: { total_tokens: 30 },
      providerState: {},
      timing: {},
    }
  }
}

export class ContextLimitProvider extends ScriptedProviderHarness {
  calls = 0

  constructor(readonly toolCallCount = 0) {
    super()
  }

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls > 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'context-limit-recovered' },
        turn: { role: 'assistant', content: 'Recovered after context limit' },
        toolCalls: [],
        usage: { total_tokens: 10 },
        providerState: {},
        timing: {},
      }
      return
    }
    const toolCalls = Array.from(
      { length: this.toolCallCount },
      (_, index) => ({
        id: `call:context-limit-${index + 1}` as CallId,
        toolId: 'read_file',
        args: { path: `fixture-${index + 1}.txt` },
        reason: `Inspect context-limit fixture ${index + 1}`,
      }),
    )
    yield {
      type: 'completed',
      rawResponse: { id: 'context-limit' },
      turn:
        toolCalls.length === 0
          ? { role: 'assistant', content: 'Response at the context limit' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.toolId,
                  arguments: JSON.stringify({
                    ...call.args,
                    _agent_intent: call.reason,
                  }),
                },
              })),
            },
      toolCalls,
      usage: { total_tokens: 160_000 },
      providerState: {},
      timing: {},
    }
  }
}
