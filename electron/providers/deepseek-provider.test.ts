import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_TOOL_INTENT_LENGTH,
} from '../../shared/durable'
import type { CallId } from '../../shared/ids'
import type { ProviderProfile, ReasoningEffort } from '../../shared/config'
import {
  CANONICAL_JSON_LIMITS,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import { DeepSeekProvider, OpenAICompatibleProvider } from './deepseek-provider'
import type { ProviderEvent, ProviderStreamRequest } from './provider'

function sseResponse(payloads: JsonValue[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function wireTools(tools: JsonValue[]): JsonValue[] {
  return tools.map((candidate) => {
    const cloned = structuredClone(candidate)
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
      return cloned
    }
    const fn = cloned.function
    if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
      delete fn['x-agent-intent-property']
    }
    return cloned
  })
}

function streamRequest(input: {
  messages: JsonValue[]
  tools: JsonValue[]
  signal: AbortSignal
  model?: string
  reasoning?: ReasoningEffort
  profile?: ProviderProfile
  responseFormat?: { type: 'json_object' }
  providerRequestOverride?: JsonObject
}): ProviderStreamRequest {
  const reasoning = input.reasoning ?? 'off'
  const tools = wireTools(input.tools)
  return {
    providerRequest:
      input.providerRequestOverride ??
      ({
        model: input.model ?? 'fixture',
        messages: input.messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(input.responseFormat
          ? { response_format: input.responseFormat }
          : {}),
        ...(input.profile === 'generic'
          ? {}
          : {
              thinking: {
                type: reasoning === 'off' ? 'disabled' : 'enabled',
              },
              ...(reasoning === 'off' ? {} : { reasoning_effort: reasoning }),
            }),
      } as JsonObject),
    normalizedMessages: structuredClone(input.messages) as JsonObject[],
    toolDefinitions: structuredClone(input.tools),
    signal: input.signal,
  }
}

describe('DeepSeekProvider', () => {
  it.each([
    [
      'text',
      {
        choices: [
          {
            delta: { content: 'x'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1) },
          },
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
  ])('stops accumulating oversized %s', async (_label, chunk, expected) => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () => sseResponse([chunk as JsonValue]),
    })

    await expect(async () => {
      for await (const event of provider.stream(
        streamRequest({
          messages: [{ role: 'user', content: 'continue' }],
          tools: [],
          signal: new AbortController().signal,
        }),
      )) {
        // Consume until the provider rejects the oversized accumulation.
        void event
      }
    }).rejects.toThrow(expected)
  })

  it('sends a fork request body exactly while keeping credentials in headers', async () => {
    let body = ''
    let authorization = ''
    let requestedEndpoint = ''
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      endpoint: 'https://gateway.example/custom/chat?api-version=1',
      apiKey: 'current-secret',
      fetchImpl: async (input, init) => {
        requestedEndpoint = String(input)
        body = String(init?.body)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return sseResponse([])
      },
    })
    const recordedRequest = {
      model: 'recorded-model',
      messages: [{ role: 'user', content: 'recorded' }],
      temperature: 0.25,
      stream: true,
    }

    const stream = provider
      .stream(
        streamRequest({
          messages: [{ role: 'user', content: 'normalized' }],
          tools: [],
          providerRequestOverride: recordedRequest,
          signal: new AbortController().signal,
        }),
      )
      [Symbol.asyncIterator]()

    while (!(await stream.next()).done) {
      // Consume the empty fixture's synthesized completion.
    }

    expect(JSON.parse(body)).toEqual(recordedRequest)
    expect(body).not.toContain('current-secret')
    expect(authorization).toBe('Bearer current-secret')
    expect(requestedEndpoint).toBe(
      'https://gateway.example/custom/chat?api-version=1',
    )
  })

  it('preserves reasoning continuation, tool calls and raw cache usage fields', async () => {
    let wireBody = ''
    const usage = {
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_cache_hit_tokens: 12,
      prompt_cache_miss_tokens: 8,
      future_provider_field: 99,
    }
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      createCallId: () => 'call-generated' as CallId,
      fetchImpl: async (_input, init) => {
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
                      id: 'call-tool',
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
                        arguments: '"_agent_intent":"Read project docs"}',
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
    const events: ProviderEvent[] = []

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'Read the file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { _agent_intent: { type: 'string' } },
              },
              'x-agent-intent-property': '_agent_intent',
            },
          },
        ],
        reasoning: 'high',
        signal: new AbortController().signal,
      }),
    )) {
      events.push(event)
    }

    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      usage,
    })
    const completed = events.find(
      (event): event is Extract<ProviderEvent, { type: 'completed' }> =>
        event.type === 'completed',
    )
    expect(completed).toMatchObject({
      usage,
      finishReason: 'tool_calls',
      turn: {
        reasoning_content: 'Think.',
        tool_calls: [
          {
            id: 'call-tool',
            function: {
              name: 'read_file',
              arguments:
                '{"path":"README.md","_agent_intent":"Read project docs"}',
            },
          },
        ],
      },
      toolCalls: [
        {
          id: 'call-tool',
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'Read project docs',
        },
      ],
    })
    expect(wireBody).not.toContain('x-agent-intent-property')
    expect(wireBody).toContain('_agent_intent')
    expect(JSON.parse(wireBody)).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('truncates provider tool intent to the advertised schema limit', async () => {
    const intent = 'x'.repeat(MAX_TOOL_INTENT_LENGTH + 128)
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-tool',
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
    const events: ProviderEvent[] = []

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'Read the file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { _agent_intent: { type: 'string' } },
              },
              'x-agent-intent-property': '_agent_intent',
            },
          },
        ],
        signal: new AbortController().signal,
      }),
    )) {
      events.push(event)
    }

    const completed = events.find(
      (event): event is Extract<ProviderEvent, { type: 'completed' }> =>
        event.type === 'completed',
    )
    expect(completed?.toolCalls[0]?.reason).toBe(
      intent.slice(0, MAX_TOOL_INTENT_LENGTH),
    )
  })

  it('records TTFT for a tool-only response', async () => {
    const timestamps = [100, 125, 175]
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      now: () => timestamps.shift() ?? 175,
      fetchImpl: async () =>
        sseResponse([
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-tool-only',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"README.md"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
    })
    const events: ProviderEvent[] = []

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'Read the file' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    )) {
      events.push(event)
    }

    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      timing: { ttftMs: 25, totalMs: 75 },
    })
  })

  it('preserves a provider truncation finish reason', async () => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            choices: [
              {
                finish_reason: 'length',
                delta: { content: 'partial' },
              },
            ],
          },
        ]),
    })
    const events: ProviderEvent[] = []

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'continue' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    )) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      finishReason: 'length',
      turn: { content: 'partial' },
    })
  })

  it('sends the documented maximum effort and disables thinking explicitly', async () => {
    const bodies: unknown[] = []
    for (const reasoning of ['max', 'off'] as const) {
      const provider = new DeepSeekProvider({
        baseURL: 'https://api.example/v1',
        apiKey: 'secret',
        fetchImpl: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return sseResponse([])
        },
      })
      for await (const event of provider.stream(
        streamRequest({
          messages: [{ role: 'user', content: 'hello' }],
          tools: [],
          model: 'deepseek-v4-pro',
          reasoning,
          signal: new AbortController().signal,
        }),
      )) {
        void event
      }
    }

    expect(bodies).toEqual([
      expect.objectContaining({
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
      }),
      expect.objectContaining({ thinking: { type: 'disabled' } }),
    ])
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('sends JSON object response format when requested', async () => {
    let body = ''
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async (_input, init) => {
        body = String(init?.body)
        return sseResponse([])
      },
    })

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'return json' }],
        tools: [],
        model: 'deepseek-v4-flash',
        reasoning: 'high',
        responseFormat: { type: 'json_object' },
        signal: new AbortController().signal,
      }),
    )) {
      void event
    }

    expect(JSON.parse(body)).toMatchObject({
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('does not send DeepSeek-specific thinking parameters for generic OpenAI-compatible providers', async () => {
    let body = ''
    const provider = new OpenAICompatibleProvider({
      providerId: 'local-openai',
      profile: 'generic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async (_input, init) => {
        body = String(init?.body)
        return sseResponse([])
      },
    })

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        model: 'generic-model',
        reasoning: 'max',
        profile: 'generic',
        signal: new AbortController().signal,
      }),
    )) {
      void event
    }

    const parsed = JSON.parse(body)
    expect(parsed).toMatchObject({
      model: 'generic-model',
      stream: true,
    })
    expect(parsed).not.toHaveProperty('thinking')
    expect(parsed).not.toHaveProperty('reasoning_effort')
  })

  it('preserves hidden reasoning continuation when display is off', async () => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'Hidden but required.',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-tool',
                      function: { name: 'read_file', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
        ]),
    })
    const events: ProviderEvent[] = []

    for await (const event of provider.stream(
      streamRequest({
        messages: [{ role: 'user', content: 'Read' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    )) {
      events.push(event)
    }

    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      turn: { reasoning_content: 'Hidden but required.' },
    })
  })

  it('does not expose an upstream error body', async () => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        new Response('{"error":{"message":"secret request echo"}}', {
          status: 400,
        }),
    })

    const consume = async () => {
      const stream = provider
        .stream(
          streamRequest({
            messages: [{ role: 'user', content: 'hello' }],
            tools: [],
            signal: new AbortController().signal,
          }),
        )
        [Symbol.asyncIterator]()
      await stream.next()
    }

    await expect(consume()).rejects.toThrow(
      'deepseek request failed with status 400',
    )
    await expect(consume()).rejects.not.toThrow('secret request echo')
  })
})
