import { describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DeepSeekProvider, OpenAICompatibleProvider } from './deepseek-provider'
import type { ProviderEvent } from './provider'

function sseResponse(payloads: JsonValue[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('DeepSeekProvider', () => {
  it('sends a fork request body exactly while keeping credentials in headers', async () => {
    let body = ''
    let authorization = ''
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      model: 'current-model',
      apiKey: 'current-secret',
      reasoning: 'off',
      fetchImpl: async (_input, init) => {
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
      .streamChat({
        messages: [{ role: 'user', content: 'normalized' }],
        tools: [],
        providerRequestOverride: recordedRequest,
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]()

    while (!(await stream.next()).done) {
      // Consume the empty fixture's synthesized completion.
    }

    expect(JSON.parse(body)).toEqual(recordedRequest)
    expect(body).not.toContain('current-secret')
    expect(authorization).toBe('Bearer current-secret')
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
      model: 'fixture',
      apiKey: 'secret',
      reasoning: 'high',
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

    for await (const event of provider.streamChat({
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
    })) {
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

  it('sends the documented maximum effort and disables thinking explicitly', async () => {
    const bodies: unknown[] = []
    for (const reasoning of ['max', 'off'] as const) {
      const provider = new DeepSeekProvider({
        baseURL: 'https://api.example/v1',
        model: 'deepseek-v4-pro',
        apiKey: 'secret',
        reasoning,
        fetchImpl: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return sseResponse([])
        },
      })
      for await (const event of provider.streamChat({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        signal: new AbortController().signal,
      })) {
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
      model: 'deepseek-v4-flash',
      apiKey: 'secret',
      reasoning: 'high',
      fetchImpl: async (_input, init) => {
        body = String(init?.body)
        return sseResponse([])
      },
    })

    for await (const event of provider.streamChat({
      messages: [{ role: 'user', content: 'return json' }],
      tools: [],
      responseFormat: { type: 'json_object' },
      signal: new AbortController().signal,
    })) {
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
      model: 'generic-model',
      apiKey: 'secret',
      reasoning: 'max',
      fetchImpl: async (_input, init) => {
        body = String(init?.body)
        return sseResponse([])
      },
    })

    for await (const event of provider.streamChat({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
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
      model: 'fixture',
      apiKey: 'secret',
      reasoning: 'off',
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

    for await (const event of provider.streamChat({
      messages: [{ role: 'user', content: 'Read' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      turn: { reasoning_content: 'Hidden but required.' },
    })
  })

  it('does not expose an upstream error body', async () => {
    const provider = new DeepSeekProvider({
      baseURL: 'https://api.example/v1',
      model: 'fixture',
      apiKey: 'secret',
      reasoning: 'off',
      fetchImpl: async () =>
        new Response('{"error":{"message":"secret request echo"}}', {
          status: 400,
        }),
    })

    const consume = async () => {
      const stream = provider
        .streamChat({
          messages: [{ role: 'user', content: 'hello' }],
          tools: [],
          signal: new AbortController().signal,
        })
        [Symbol.asyncIterator]()
      await stream.next()
    }

    await expect(consume()).rejects.toThrow(
      'deepseek request failed with status 400',
    )
    await expect(consume()).rejects.not.toThrow('secret request echo')
  })
})
