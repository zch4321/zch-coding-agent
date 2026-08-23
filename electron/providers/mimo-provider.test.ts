import { describe, expect, it, vi } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendToolResult,
  appendUserInput,
  canonicalHash,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { MiMoProvider } from './mimo-provider'
import {
  providerRequestDiagnostics,
  type ModelProvider,
  type ProviderCompileInput,
  type ProviderEvent,
  type ProviderToolDefinition,
} from './provider'

function sseResponse(payloads: JsonValue[]): Response {
  const body = [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function route(
  reasoning: ModelRouteSnapshot['reasoning'] = 'max',
): ModelRouteSnapshot {
  return {
    schemaVersion: 2,
    purpose: 'main',
    providerType: 'mimo.chat-completions',
    providerId: 'mimo',
    model: 'mimo-v2.5-pro',
    reasoning,
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    providerConfigRevision: 1,
  }
}

function historyState(content = 'Inspect the project'): CanonicalHistoryState {
  const state: CanonicalHistoryState = {
    sessionId: 'session:mimo-provider-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
  appendUserInput(state, {
    content,
    clientRequestId: 'request:mimo-provider-test',
  })
  return state
}

function compileInput(
  input: {
    reasoning?: ModelRouteSnapshot['reasoning']
    state?: CanonicalHistoryState
    tools?: ProviderToolDefinition[]
    maxOutputTokens?: number
    structuredOutput?: ProviderCompileInput['structuredOutput']
  } = {},
): ProviderCompileInput {
  const state = input.state ?? historyState()
  return {
    history: new MessageHistoryCompiler().compile(state.history),
    route: route(input.reasoning),
    tools: input.tools ?? [],
    maxOutputTokens: input.maxOutputTokens ?? 131_072,
    ...(input.structuredOutput
      ? { structuredOutput: input.structuredOutput }
      : {}),
  }
}

function readTool(): ProviderToolDefinition {
  return {
    name: 'read_file',
    description: 'Read one workspace file',
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

describe('MiMo Provider', () => {
  it('uses the documented Chat controls and normalizes reasoning tool calls', async () => {
    let requestURL = ''
    let wireBody = ''
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requestURL = String(url)
        wireBody = String(init?.body)
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'Inspect first.',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call:mimo-read',
                      function: {
                        name: 'read_file',
                        arguments:
                          '{"path":"README.md","_agent_intent":"Read docs"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ finish_reason: 'tool_calls', delta: {} }],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 4,
              total_tokens: 24,
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          },
        ])
      },
    ) as typeof fetch
    const provider = new MiMoProvider({
      providerId: 'mimo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
      fetchImpl,
    })

    const { request, events } = await collect(
      provider,
      compileInput({ tools: [readTool()] }),
    )

    expect(requestURL).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(JSON.parse(wireBody)).toEqual(request)
    expect(request).toMatchObject({
      model: 'mimo-v2.5-pro',
      stream: true,
      max_completion_tokens: 131_072,
      thinking: { type: 'enabled' },
    })
    expect(request).not.toHaveProperty('max_tokens')
    expect(request).not.toHaveProperty('reasoning_effort')
    expect(request).not.toHaveProperty('stream_options')
    expect(events.map((event) => event.type)).toEqual([
      'reasoning.delta',
      'tool.delta',
      'completed',
    ])
    const completed = events.find((event) => event.type === 'completed')
    expect(completed?.turn).toMatchObject({
      normalizedReasoningText: 'Inspect first.',
      toolCalls: [
        {
          id: 'call:mimo-read',
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'Read docs',
        },
      ],
      finishReason: 'tool_calls',
      providerContinuation: {
        providerType: 'mimo.chat-completions',
      },
      usage: {
        promptTokens: 20,
        completionTokens: 4,
        reasoningTokens: 2,
        totalTokens: 24,
      },
    })
    expect(
      providerRequestDiagnostics({
        request,
        normalizedMessages: [],
      }),
    ).toMatchObject({
      outputTokenField: 'max_completion_tokens',
      maxOutputTokens: 131_072,
      thinkingMode: 'enabled',
    })
  })

  it('maps all enabled efforts to thinking enabled and off to disabled', () => {
    const provider = new MiMoProvider({
      providerId: 'mimo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
    })

    for (const reasoning of [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const) {
      expect(
        provider.compile(compileInput({ reasoning })).request,
      ).toMatchObject({ thinking: { type: 'enabled' } })
    }
    expect(
      provider.compile(compileInput({ reasoning: 'off' })).request,
    ).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('rejects output limits outside MiMo documented bounds', () => {
    const provider = new MiMoProvider({
      providerId: 'mimo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
    })

    expect(() =>
      provider.compile(compileInput({ maxOutputTokens: 131_073 })),
    ).toThrow(/between 1 and 131072/u)
  })

  it('replays MiMo reasoning content across a tool-result boundary', () => {
    const state = historyState()
    const callId = 'call:mimo-continuation' as CallId
    const parts = [
      {
        type: 'tool_call' as const,
        callId,
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    ]
    appendAssistantTurn(state, {
      text: '',
      toolCalls: [
        { id: callId, toolId: 'read_file', args: { path: 'README.md' } },
      ],
      reasoning: 'Keep this MiMo reasoning.',
      route: route(),
      continuation: {
        schemaVersion: 2,
        providerType: 'mimo.chat-completions',
        format: 'chat-completions.assistant.v1',
        data: {
          partsHash: canonicalHash(parts),
          assistant: {
            role: 'assistant',
            content: null,
            reasoning_content: 'Keep this MiMo reasoning.',
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      },
    })
    appendToolResult(state, {
      callId,
      content: [{ type: 'text', text: 'project docs' }],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const provider = new MiMoProvider({
      providerId: 'mimo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
    })

    const request = provider.compile(compileInput({ state })).request

    expect((request.messages as JsonValue[])[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'Keep this MiMo reasoning.',
    })
    expect((request.messages as JsonValue[])[2]).toEqual({
      role: 'tool',
      tool_call_id: callId,
      content: 'project docs',
    })
  })

  it('uses the same documented fields for synthetic compaction', () => {
    const provider = new MiMoProvider({
      providerId: 'mimo',
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'secret',
    })
    const input = compileInput({ maxOutputTokens: 32_768 })

    const call = provider.compileCompact({
      history: input.history,
      route: input.route,
      instructions: 'SUMMARIZE_LAST',
      maxOutputTokens: 32_768,
    })

    expect(call.mode).toBe('synthetic')
    expect(call.request).toMatchObject({
      max_completion_tokens: 32_768,
      thinking: { type: 'enabled' },
    })
    expect(call.request).not.toHaveProperty('tools')
    expect(call.normalizedMessages.at(-1)).toEqual({
      role: 'user',
      content: 'SUMMARIZE_LAST',
    })
  })
})
