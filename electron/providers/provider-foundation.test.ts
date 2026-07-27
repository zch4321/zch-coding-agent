import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_TOOL_INTENT_LENGTH,
} from '../../shared/durable'
import type { CallId, SessionId } from '../../shared/ids'
import {
  CANONICAL_JSON_LIMITS,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import type { ProviderContinuationEnvelope } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendToolResult,
  appendUserInput,
  canonicalHash,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { DeepSeekProvider } from './deepseek-provider'
import { GenericChatCompletionsProvider } from './generic-chat-completions-provider'
import type {
  ModelProvider,
  ProviderCompileInput,
  ProviderEvent,
  ProviderToolDefinition,
} from './provider'
import { createConfiguredProvider } from './provider-factory'

function sseResponse(payloads: JsonValue[], done = true): Response {
  const body = [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    ...(done ? ['data: [DONE]\n\n'] : []),
  ].join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function route(
  providerType: 'deepseek.chat-completions' | 'generic.chat-completions',
  reasoning: ModelRouteSnapshot['reasoning'] = 'high',
): ModelRouteSnapshot {
  return {
    schemaVersion: 2,
    purpose: 'main',
    providerType,
    providerId: providerType.startsWith('deepseek') ? 'deepseek' : 'generic',
    model: 'golden-model',
    reasoning,
    endpoint: 'https://api.example/v1/chat/completions',
    providerConfigRevision: 1,
  }
}

function historyState(content = 'Hello'): CanonicalHistoryState {
  const state: CanonicalHistoryState = {
    sessionId: 'session:provider-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
  appendUserInput(state, {
    content,
    clientRequestId: 'request:provider-test',
  })
  return state
}

function compileInput(input: {
  providerType: 'deepseek.chat-completions' | 'generic.chat-completions'
  reasoning?: ModelRouteSnapshot['reasoning']
  state?: CanonicalHistoryState
  tools?: ProviderToolDefinition[]
  structuredOutput?: 'json_object'
}): ProviderCompileInput {
  const state = input.state ?? historyState()
  return {
    history: new MessageHistoryCompiler().compile(state.history),
    route: route(input.providerType, input.reasoning),
    tools: input.tools ?? [],
    ...(input.structuredOutput
      ? { structuredOutput: input.structuredOutput }
      : {}),
  }
}

async function collect(
  provider: ModelProvider,
  input: ProviderCompileInput,
): Promise<{ request: JsonObject; events: ProviderEvent[] }> {
  const call = provider.compile(input)
  const events: ProviderEvent[] = []
  for await (const event of provider.stream(call, {
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return { request: call.request, events }
}

function neutralReadTool(): ProviderToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a workspace file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        _agent_intent: { type: 'string' },
      },
      required: ['path', '_agent_intent'],
    },
    intentParameter: '_agent_intent',
  }
}

function completed(events: ProviderEvent[]) {
  return events.find(
    (event): event is Extract<ProviderEvent, { type: 'completed' }> =>
      event.type === 'completed',
  )
}

describe('P11 Provider foundation', () => {
  it.each([
    {
      name: 'DeepSeek',
      providerType: 'deepseek.chat-completions' as const,
      create(fetchImpl: typeof fetch): ModelProvider {
        return new DeepSeekProvider({
          baseURL: 'https://api.example/v1',
          apiKey: 'secret',
          fetchImpl,
        })
      },
      expectedVendorFields: {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      },
    },
    {
      name: 'Generic Chat',
      providerType: 'generic.chat-completions' as const,
      create(fetchImpl: typeof fetch): ModelProvider {
        return new GenericChatCompletionsProvider({
          providerId: 'generic',
          baseURL: 'https://api.example/v1',
          apiKey: 'secret',
          fetchImpl,
        })
      },
      expectedVendorFields: {},
    },
  ])(
    '$name golden compiles and streams a canonical text turn',
    async (fixture) => {
      let wireBody = ''
      const provider = fixture.create(async (_url, init) => {
        wireBody = String(init?.body)
        return sseResponse([
          { choices: [{ delta: { content: 'Hello' } }] },
          {
            choices: [{ finish_reason: 'stop', delta: { content: ' world' } }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          },
        ])
      })
      const { request, events } = await collect(
        provider,
        compileInput({ providerType: fixture.providerType }),
      )

      expect(request).toEqual({
        model: 'golden-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        stream_options: { include_usage: true },
        ...fixture.expectedVendorFields,
      })
      expect(JSON.parse(wireBody)).toEqual(request)
      expect(events.map((event) => event.type)).toEqual([
        'text.delta',
        'text.delta',
        'completed',
      ])
      expect(completed(events)?.turn).toMatchObject({
        parts: [{ type: 'text', text: 'Hello world' }],
        toolCalls: [],
        usage: {
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
          raw: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          },
        },
        finishReason: 'completed',
      })
    },
  )

  it('normalizes DeepSeek reasoning, split tool arguments and raw usage', async () => {
    let wireBody = ''
    const usage = {
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_cache_hit_tokens: 12,
      prompt_cache_miss_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 3 },
      future_provider_field: 99,
    }
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async (_url, init) => {
        wireBody = String(init?.body)
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'Think.',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call:read',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"README.md",',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '"_agent_intent":"Read docs"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage,
          },
        ])
      },
    })
    const { events } = await collect(
      provider,
      compileInput({
        providerType: 'deepseek.chat-completions',
        tools: [neutralReadTool()],
      }),
    )

    expect(events.map((event) => event.type)).toEqual([
      'reasoning.delta',
      'tool.delta',
      'tool.delta',
      'completed',
    ])
    expect(completed(events)?.turn).toMatchObject({
      parts: [
        {
          type: 'tool_call',
          callId: 'call:read',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      toolCalls: [
        {
          id: 'call:read',
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'Read docs',
        },
      ],
      normalizedReasoningText: 'Think.',
      usage: {
        promptTokens: 20,
        completionTokens: 4,
        totalTokens: 24,
        reasoningTokens: 3,
        cacheHitTokens: 12,
        cacheMissTokens: 8,
        raw: usage,
      },
      finishReason: 'tool_calls',
    })
    expect(wireBody).not.toContain('intentParameter')
    expect(wireBody).toContain('_agent_intent')
  })

  it('truncates tool intent and maps length finish reason', async () => {
    const intent = 'x'.repeat(MAX_TOOL_INTENT_LENGTH + 128)
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            choices: [
              {
                finish_reason: 'length',
                delta: {
                  content: 'partial',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call:read',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({
                          path: 'README.md',
                          _agent_intent: intent,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
    })
    const { events } = await collect(
      provider,
      compileInput({
        providerType: 'deepseek.chat-completions',
        tools: [neutralReadTool()],
      }),
    )
    expect(completed(events)?.turn.toolCalls[0]?.reason).toBe(
      intent.slice(0, MAX_TOOL_INTENT_LENGTH),
    )
    expect(completed(events)?.turn.finishReason).toBe('truncated')
  })

  it('compiles structured output and all DeepSeek thinking modes', () => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    const maximum = provider.compile(
      compileInput({
        providerType: 'deepseek.chat-completions',
        reasoning: 'max',
        structuredOutput: 'json_object',
      }),
    )
    const disabled = provider.compile(
      compileInput({
        providerType: 'deepseek.chat-completions',
        reasoning: 'off',
      }),
    )
    expect(maximum.request).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      response_format: { type: 'json_object' },
    })
    expect(disabled.request).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(disabled.request).not.toHaveProperty('reasoning_effort')
  })

  it('sends credentials only in headers and preserves the compiled body', async () => {
    let authorization = ''
    let body = ''
    let endpoint = ''
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      endpoint: 'https://gateway.example/custom/chat?api-version=1',
      apiKey: 'secret-sentinel',
      fetchImpl: async (input, init) => {
        endpoint = String(input)
        body = String(init?.body)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return sseResponse([
          { choices: [{ finish_reason: 'stop', delta: { content: 'ok' } }] },
        ])
      },
    })
    const call = provider.compile(
      compileInput({ providerType: 'deepseek.chat-completions' }),
    )
    for await (const event of provider.stream(call, {
      signal: new AbortController().signal,
    })) {
      void event
    }
    expect(JSON.parse(body)).toEqual(call.request)
    expect(body).not.toContain('secret-sentinel')
    expect(authorization).toBe('Bearer secret-sentinel')
    expect(endpoint).toBe('https://gateway.example/custom/chat?api-version=1')
  })

  it.each([
    [
      'text',
      {
        choices: [
          { delta: { content: 'x'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1) } },
        ],
      },
      /Provider text exceeds maximum length/u,
    ],
    [
      'reasoning',
      {
        choices: [
          {
            delta: {
              reasoning_content: 'x'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
            },
          },
        ],
      },
      /Provider reasoning exceeds maximum length/u,
    ],
    [
      'tool arguments',
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call:large',
                  function: {
                    name: 'read_file',
                    arguments: 'x'.repeat(CANONICAL_JSON_LIMITS.maxBytes + 1),
                  },
                },
              ],
            },
          },
        ],
      },
      /Provider tool arguments exceed maximum size/u,
    ],
    [
      'tool count',
      {
        choices: [
          {
            delta: {
              tool_calls: Array.from(
                { length: MAX_MESSAGE_PARTS + 1 },
                (_value, index) => ({
                  index,
                  id: `call:${index}`,
                  function: { name: 'read_file', arguments: '{}' },
                }),
              ),
            },
          },
        ],
      },
      /Provider tool calls exceed maximum count/u,
    ],
  ])('rejects oversized %s accumulation', async (_name, chunk, expected) => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () => sseResponse([chunk as JsonValue]),
    })
    await expect(
      collect(
        provider,
        compileInput({ providerType: 'deepseek.chat-completions' }),
      ),
    ).rejects.toThrow(expected)
  })

  it.each([
    [[], /empty assistant turn/u],
    [
      [{ choices: [{ delta: { reasoning_content: 'private thought' } }] }],
      /reasoning without an assistant answer/u,
    ],
  ])(
    'rejects a stream without a canonical completion',
    async (chunks, error) => {
      const provider = new DeepSeekProvider({
        baseURL: 'https://api.example/v1',
        apiKey: 'secret',
        fetchImpl: async () => sseResponse(chunks as JsonValue[]),
      })
      await expect(
        collect(
          provider,
          compileInput({ providerType: 'deepseek.chat-completions' }),
        ),
      ).rejects.toThrow(error)
    },
  )

  it('replays valid DeepSeek continuation exactly', () => {
    const state = historyState('Read the file')
    const parts = [
      {
        type: 'tool_call' as const,
        callId: 'call:continuation' as CallId,
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    ]
    const continuation: ProviderContinuationEnvelope = {
      schemaVersion: 2,
      providerType: 'deepseek.chat-completions',
      format: 'chat-completions.assistant.v1',
      data: {
        partsHash: canonicalHash(parts),
        assistant: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Preserve this chain.',
          vendor_state: ['ordered', 'payload'],
          tool_calls: [
            {
              id: 'call:continuation',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      },
    }
    appendAssistantTurn(state, {
      text: '',
      toolCalls: [
        {
          id: 'call:continuation' as CallId,
          toolId: 'read_file',
          args: { path: 'README.md' },
        },
      ],
      reasoning: 'Preserve this chain.',
      route: route('deepseek.chat-completions'),
      continuation,
    })
    appendToolResult(state, {
      callId: 'call:continuation' as CallId,
      content: { content: 'docs' },
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    const call = provider.compile(
      compileInput({
        providerType: 'deepseek.chat-completions',
        state,
      }),
    )
    expect((call.request.messages as JsonValue[])[1]).toMatchObject({
      vendor_state: ['ordered', 'payload'],
      reasoning_content: 'Preserve this chain.',
    })
    expect((call.request.messages as JsonValue[])[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call:continuation',
      content: JSON.stringify([{ type: 'json', value: { content: 'docs' } }]),
    })
  })

  it.each([
    ['Provider Type mismatch', 'generic.chat-completions', undefined],
    ['parts hash mismatch', 'deepseek.chat-completions', 'bad-hash'],
  ])('falls back to canonical replay on %s', (_name, providerType, hash) => {
    const state = historyState('Read')
    const callId = 'call:fallback' as CallId
    const continuation: ProviderContinuationEnvelope = {
      schemaVersion: 2,
      providerType,
      format: 'chat-completions.assistant.v1',
      data: {
        partsHash:
          hash ??
          canonicalHash([
            {
              type: 'tool_call',
              callId,
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
          ]),
        assistant: {
          role: 'assistant',
          content: null,
          vendor_state: 'must-not-replay',
        },
      },
    }
    appendAssistantTurn(state, {
      text: '',
      toolCalls: [
        { id: callId, toolId: 'read_file', args: { path: 'README.md' } },
      ],
      route: route('deepseek.chat-completions'),
      continuation,
    })
    appendToolResult(state, {
      callId,
      content: [],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    const compiled = provider.compile(
      compileInput({ providerType: 'deepseek.chat-completions', state }),
    )
    expect((compiled.request.messages as JsonValue[])[1]).not.toHaveProperty(
      'vendor_state',
    )
  })

  it('rejects corrupt continuation for the same Provider Type', () => {
    const state = historyState('Read')
    const callId = 'call:corrupt' as CallId
    const parts = [
      {
        type: 'tool_call' as const,
        callId,
        name: 'read_file',
        arguments: {},
      },
    ]
    appendAssistantTurn(state, {
      text: '',
      toolCalls: [{ id: callId, toolId: 'read_file', args: {} }],
      route: route('deepseek.chat-completions'),
      continuation: {
        schemaVersion: 2,
        providerType: 'deepseek.chat-completions',
        format: 'chat-completions.assistant.v1',
        data: { partsHash: canonicalHash(parts), assistant: 'corrupt' },
      },
    })
    appendToolResult(state, {
      callId,
      content: [],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    expect(() =>
      provider.compile(
        compileInput({ providerType: 'deepseek.chat-completions', state }),
      ),
    ).toThrow(/continuation assistant payload is corrupt/u)
  })

  it('uses an exhaustive factory without Provider inheritance', () => {
    const base = {
      id: 'fixture',
      label: 'Fixture',
      revision: 1,
      baseURL: 'https://api.example/v1',
      model: 'model',
      reasoning: 'off' as const,
      modelCatalog: [],
      modelOverrides: {},
      credentialConfigured: true,
      credentialSource: 'safe-storage' as const,
    }
    expect(
      createConfiguredProvider(
        { ...base, providerType: 'deepseek.chat-completions' },
        'secret',
      ),
    ).toBeInstanceOf(DeepSeekProvider)
    expect(
      createConfiguredProvider(
        { ...base, providerType: 'generic.chat-completions' },
        'secret',
      ),
    ).toBeInstanceOf(GenericChatCompletionsProvider)
    expect(Object.getPrototypeOf(DeepSeekProvider.prototype)).toBe(
      Object.prototype,
    )
    expect(
      Object.getPrototypeOf(GenericChatCompletionsProvider.prototype),
    ).toBe(Object.prototype)
  })
})
