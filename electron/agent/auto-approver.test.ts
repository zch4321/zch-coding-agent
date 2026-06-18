import { describe, expect, it } from 'vitest'
import type { JsonValue } from '../../shared/json'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from './provider'
import {
  ProviderAutoApprover,
  strictAutoApproverOutput,
  type AutoApproverInput,
} from './auto-approver'

const input: AutoApproverInput = {
  tool: {
    id: 'write_file',
    effects: ['filesystem.write'],
    defaultRisk: 'review',
  },
  args: { path: 'README.md', content: 'updated' },
  reason: 'Update the README',
  workspacePath: 'F:/workspace',
  policySignals: [],
}

class ErrorProvider implements LLMProvider {
  async *streamChat(): AsyncIterable<ProviderEvent> {
    yield* []
    throw new Error('network failed')
  }
}

class HangingProvider implements LLMProvider {
  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
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

class TextProvider implements LLMProvider {
  readonly #text: string

  constructor(text: string) {
    this.#text = text
  }

  async *streamChat(): AsyncIterable<ProviderEvent> {
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
    )

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toEqual({
      decision: 'safe',
      note: 'bounded edit',
      valid: true,
    })
  })

  it('converts network errors to dangerous human-review fallback', async () => {
    const approver = new ProviderAutoApprover(new ErrorProvider())

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'network',
    })
  })

  it('converts timeout to dangerous human-review fallback', async () => {
    const approver = new ProviderAutoApprover(new HangingProvider(), 10)

    await expect(
      approver.evaluate(input, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: 'dangerous',
      valid: false,
      failure: 'timeout',
    })
  })
})
