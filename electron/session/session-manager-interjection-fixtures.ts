import type { CallId } from '../../shared/ids'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'

export class InterjectionProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  // Resolves when the first tool-bearing turn has been consumed, allowing the
  // test to enqueue an interjection before the second provider call fires.
  firstTurnConsumed: { resolve: () => void; promise: Promise<void> }

  constructor() {
    super()
    let resolve: () => void = () => undefined
    this.firstTurnConsumed = {
      resolve: () => resolve(),
      promise: new Promise<void>((r) => {
        resolve = r
      }),
    }
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'interject-first' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"notes.md"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-read' as CallId,
            toolId: 'read_file',
            args: { path: 'notes.md' },
            reason: 'Read the note',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      // Signal the test that the tool batch is about to run.
      this.firstTurnConsumed.resolve()
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Acknowledged the interjection',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'interject-final' },
      turn: {
        role: 'assistant',
        content: 'Acknowledged the interjection',
      },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class FinalAnswerInterjectionProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  // Gate released by the test once the interjection has been queued, so the
  // first provider turn is held open until the run loop can observe it.
  firstTurnGate: { resolve: () => void; promise: Promise<void> }

  constructor() {
    super()
    let resolve: () => void = () => undefined
    this.firstTurnGate = {
      resolve: () => resolve(),
      promise: new Promise<void>((r) => {
        resolve = r
      }),
    }
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      yield {
        type: 'text.delta',
        delta: 'Initial final answer',
        raw: {},
      }
      // Hold the turn open until the test queues an interjection, then emit
      // the completion so the run loop observes the pending interjection
      // when it reaches the no-tool-calls branch.
      await this.firstTurnGate.promise
      yield {
        type: 'completed',
        rawResponse: { id: 'final-first' },
        turn: { role: 'assistant', content: 'Initial final answer' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Final answer after interjection',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'final-after' },
      turn: { role: 'assistant', content: 'Final answer after interjection' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}
