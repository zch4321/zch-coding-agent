import { describe, expect, it } from 'vitest'
import type { JsonValue } from '../../shared/json'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import {
  ProviderAutoApprover,
  strictAutoApproverOutput,
  type AutoApproverInput,
} from './auto-approver'

const input: AutoApproverInput = {
  tool: {
    id: 'create_file',
    effects: ['filesystem.write'],
    defaultRisk: 'review',
  },
  args: { path: 'README.md', content: 'updated' },
  reason: 'Update the README',
  workspacePath: 'F:/workspace',
  policySignals: [],
}

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'approval',
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  reasoning: 'high',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}

class ErrorProvider extends ScriptedProviderHarness {
  async *run(): AsyncIterable<ProviderEvent> {
    yield* []
    throw new Error('network failed')
  }
}

class HangingProvider extends ScriptedProviderHarness {
  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    await new Promise<void>((_resolve, reject) => {
      request.signal.addEventListener(
        'abort',
        () => reject(request.signal.reason),
        { once: true },
      )
    })
    yield undefined as never
  }
}

/** Ends cleanly without the required Provider completion event. */
class NoCompletionProvider extends ScriptedProviderHarness {
  async *run(): AsyncIterable<ProviderEvent> {
    yield* []
  }
}

/** Emits two completion events to exercise the exactly-once guard. */
class MultipleCompletionProvider extends ScriptedProviderHarness {
  async *run(): AsyncIterable<ProviderEvent> {
    for (const id of ['first', 'second']) {
      yield {
        type: 'completed',
        rawResponse: { id },
        turn: {
          role: 'assistant',
          content: '{"decision":"safe","note":"bounded"}',
        },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }
}

class TextProvider extends ScriptedProviderHarness {
  readonly #text: string

  constructor(text: string) {
    super()
    this.#text = text
  }

  async *run(): AsyncIterable<ProviderEvent> {
    yield {
      type: 'text.delta',
      delta: this.#text,
      raw: { text: this.#text } as JsonValue,
    }
    yield {
      type: 'completed',
      rawResponse: {},
      turn: { role: 'assistant', content: this.#text },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class CapturingProvider extends ScriptedProviderHarness {
  request: ProviderStreamRequest | undefined

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.request = request
    yield {
      type: 'completed',
      rawResponse: {},
      turn: { role: 'assistant', content: '{"decision":"safe","note":"json"}' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

describe('P3 auto approver', () => {
  it.each([
    ['not json', 'not json'],
    ['unknown enum', '{"decision":"maybe","note":"x"}'],
    ['extra property', '{"decision":"safe","note":"x","allow":true}'],
    ['missing note', '{"decision":"safe"}'],
  ])('rejects %s output', (_name, text) => {
    expect(strictAutoApproverOutput(text)).toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'invalid_output',
    })
  })

  it('accepts only the strict safe decision schema', async () => {
    const approver = new ProviderAutoApprover(
      new TextProvider('{"decision":"safe","note":"bounded edit"}'),
      route,
    )

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toEqual({
      decision: 'safe',
      note: 'bounded edit',
      valid: true,
    })
  })

  it('requests JSON object output from the provider', async () => {
    const provider = new CapturingProvider()
    const approver = new ProviderAutoApprover(provider, route)

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'safe',
      valid: true,
    })
    expect(provider.request?.toolDefinitions).toEqual([])
    expect(provider.request?.providerRequest).toMatchObject({
      response_format: { type: 'json_object' },
    })
  })

  it('converts network errors to dangerous human-review fallback', async () => {
    const approver = new ProviderAutoApprover(new ErrorProvider(), route)

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'network',
    })
  })

  it.each([
    ['no completion', new NoCompletionProvider()],
    ['multiple completions', new MultipleCompletionProvider()],
  ])('classifies %s as invalid Provider output', async (_name, provider) => {
    const approver = new ProviderAutoApprover(provider, route)

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'invalid_output',
    })
  })

  it('cleans up and falls back when Provider compilation fails', async () => {
    const approver = new ProviderAutoApprover(new ErrorProvider(), {
      ...route,
      providerType: 'missing.adapter',
    })

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'network',
    })
  })

  it('converts timeout to dangerous human-review fallback', async () => {
    const approver = new ProviderAutoApprover(new HangingProvider(), route, 10)

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'timeout',
    })
  })
})
