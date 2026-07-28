import { describe, expect, it, vi } from 'vitest'
import type { CallId, MessageId, SessionId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendToolResult,
  appendUserInput,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import {
  ANTHROPIC_CONTINUATION_FORMAT,
  GenericAnthropicProvider,
} from './generic-anthropic-provider'
import type {
  ProviderCompileInput,
  ProviderEvent,
  ProviderToolDefinition,
} from './provider'

function sseResponse(payloads: JsonValue[]): Response {
  return new Response(
    payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(''),
    { status: 200 },
  )
}

function route(
  reasoning: ModelRouteSnapshot['reasoning'] = 'high',
): ModelRouteSnapshot {
  return {
    schemaVersion: 2,
    purpose: 'main',
    providerType: 'generic.anthropic',
    providerId: 'anthropic',
    model: 'claude-test',
    reasoning,
    endpoint: 'https://api.example/v1/messages',
    providerConfigRevision: 1,
  }
}

function state(): CanonicalHistoryState {
  const sessionId = 'session:anthropic' as SessionId
  const system: MessageRecord = {
    schemaVersion: 1,
    id: 'message:system' as MessageId,
    sessionId,
    seq: 1,
    visibility: 'hidden',
    inHistory: true,
    createdAt: '2026-07-28T00:00:00.000Z',
    kind: 'system_instruction',
    parts: [{ type: 'text', text: 'System guidance' }],
  }
  const value: CanonicalHistoryState = {
    sessionId,
    history: [system],
    nextMessageSeq: 2,
  }
  appendUserInput(value, {
    content: 'Hello',
    clientRequestId: 'request:anthropic',
  })
  return value
}

function readTool(): ProviderToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a file',
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

function input(
  history = state(),
  reasoning: ModelRouteSnapshot['reasoning'] = 'high',
): ProviderCompileInput {
  return {
    history: new MessageHistoryCompiler().compile(history.history),
    route: route(reasoning),
    tools: [readTool()],
    maxOutputTokens: 8_192,
  }
}

async function collect(
  provider: GenericAnthropicProvider,
  compileInput: ProviderCompileInput,
): Promise<{ request: JsonObject; events: ProviderEvent[] }> {
  const call = provider.compile(compileInput)
  const events: ProviderEvent[] = []
  for await (const event of provider.stream(call, {
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return { request: call.request, events }
}

function streamEvents(): JsonValue[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_anthropic',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        usage: {
          input_tokens: 30,
          output_tokens: 1,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 5,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspect the file.' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signed-thinking' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'I will read it.' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: {
        type: 'tool_use',
        id: 'call:anthropic',
        name: 'read_file',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"path":"README.md",',
      },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: {
        type: 'input_json_delta',
        partial_json: '"_agent_intent":"inspect project"}',
      },
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: {
        output_tokens: 12,
        output_tokens_details: { thinking_tokens: 4 },
      },
    },
    { type: 'message_stop' },
  ]
}

describe('GenericAnthropicProvider', () => {
  it('compiles system, adaptive effort, tools and JSON Schema', () => {
    const provider = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    const call = provider.compile({
      ...input(),
      structuredOutput: {
        type: 'json_schema',
        name: 'approval',
        schema: {
          type: 'object',
          properties: { decision: { type: 'string' } },
          required: ['decision'],
          additionalProperties: false,
        },
      },
    })
    expect(call.request).toEqual({
      model: 'claude-test',
      system: 'System guidance',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: readTool().inputSchema,
        },
      ],
      max_tokens: 8_192,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { decision: { type: 'string' } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      },
    })

    const disabled = provider.compile(input(state(), 'off'))
    expect(disabled.request).not.toHaveProperty('thinking')
    expect(disabled.request).not.toHaveProperty('output_config')

    const objectOnly = provider.compile({
      ...input(state(), 'off'),
      structuredOutput: { type: 'json_object' },
    })
    expect(objectOnly.request).toMatchObject({
      output_config: {
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
    })
  })

  it('groups a complete tool-result batch into one user message', () => {
    const history = state()
    appendAssistantTurn(history, {
      text: '',
      toolCalls: [
        {
          id: 'call:first' as CallId,
          toolId: 'read_file',
          args: { path: 'a' },
        },
        {
          id: 'call:second' as CallId,
          toolId: 'read_file',
          args: { path: 'b' },
        },
      ],
      route: route(),
    })
    appendToolResult(history, {
      callId: 'call:first' as CallId,
      content: 'first',
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    appendToolResult(history, {
      callId: 'call:second' as CallId,
      content: { error: 'second' },
      isError: true,
      name: 'read_file',
      status: 'failed',
      truncated: false,
    })
    const provider = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
    })
    const call = provider.compile(input(history))
    expect(call.request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call:first',
            name: 'read_file',
            input: { path: 'a' },
          },
          {
            type: 'tool_use',
            id: 'call:second',
            name: 'read_file',
            input: { path: 'b' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call:first',
            content: '[{"type":"json","value":"first"}]',
          },
          {
            type: 'tool_result',
            tool_use_id: 'call:second',
            content: '[{"type":"json","value":{"error":"second"}}]',
            is_error: true,
          },
        ],
      },
    ])
  })

  it('streams signed thinking, redacted blocks, text and tool input', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(streamEvents()),
    ) as unknown as typeof fetch
    const provider = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl,
      now: (() => {
        let value = 0
        return () => (value += 5)
      })(),
    })
    const { events } = await collect(provider, input())
    expect(events.map((event) => event.type)).toEqual([
      'reasoning.delta',
      'text.delta',
      'tool.delta',
      'tool.delta',
      'tool.delta',
      'completed',
    ])
    const completed = events.at(-1)
    if (completed?.type !== 'completed') throw new Error('missing completion')
    expect(completed.turn).toMatchObject({
      parts: [
        { type: 'text', text: 'I will read it.' },
        {
          type: 'tool_call',
          callId: 'call:anthropic',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      toolCalls: [
        {
          id: 'call:anthropic',
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'inspect project',
        },
      ],
      normalizedReasoningText: 'Inspect the file.',
      usage: {
        promptTokens: 37,
        completionTokens: 12,
        totalTokens: 49,
        reasoningTokens: 4,
        cacheHitTokens: 5,
        cacheMissTokens: 2,
      },
      finishReason: 'tool_calls',
    })
    expect(completed.turn.providerContinuation).toMatchObject({
      providerType: 'generic.anthropic',
      format: ANTHROPIC_CONTINUATION_FORMAT,
      data: {
        content: [
          {
            type: 'thinking',
            thinking: 'Inspect the file.',
            signature: 'signed-thinking',
          },
          { type: 'redacted_thinking', data: 'opaque-redacted' },
          { type: 'text', text: 'I will read it.' },
          {
            type: 'tool_use',
            id: 'call:anthropic',
            name: 'read_file',
            input: {
              path: 'README.md',
              _agent_intent: 'inspect project',
            },
          },
        ],
      },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example/v1/messages',
      expect.objectContaining({
        headers: {
          'x-api-key': 'secret',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }),
    )
  })

  it('replays matching signed content and rejects corrupt tool JSON', async () => {
    const provider = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () => sseResponse(streamEvents()),
    })
    const initial = await collect(provider, input())
    const completed = initial.events.at(-1)
    if (completed?.type !== 'completed') throw new Error('missing completion')
    const replayState = state()
    appendAssistantTurn(replayState, {
      text: 'I will read it.',
      toolCalls: [
        {
          id: 'call:anthropic' as CallId,
          toolId: 'read_file',
          args: { path: 'README.md' },
        },
      ],
      route: route(),
      continuation: completed.turn.providerContinuation,
    })
    appendToolResult(replayState, {
      callId: 'call:anthropic' as CallId,
      content: 'contents',
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const replay = provider.compile(input(replayState))
    expect(replay.request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'thinking',
              signature: 'signed-thinking',
            }),
            expect.objectContaining({
              type: 'redacted_thinking',
              data: 'opaque-redacted',
            }),
          ]),
        }),
      ]),
    )

    const assistant = replayState.history.find(
      (record) => record.kind === 'assistant_turn',
    ) as Extract<MessageRecord, { kind: 'assistant_turn' }>
    if (!assistant.providerContinuation) throw new Error('missing continuation')
    const continuationData = structuredClone(
      assistant.providerContinuation.data,
    ) as JsonObject
    assistant.providerContinuation.data = {
      ...continuationData,
      content: 'corrupt',
    }
    expect(() => provider.compile(input(replayState))).toThrow(
      'continuation content is corrupt',
    )
    assistant.providerContinuation.data = {
      ...continuationData,
      partsHash: 'different',
    }
    const fallback = provider.compile(input(replayState))
    expect(fallback.request.messages).toEqual(
      expect.arrayContaining([
        {
          role: 'assistant',
          content: expect.not.arrayContaining([
            expect.objectContaining({ type: 'thinking' }),
          ]),
        },
      ]),
    )

    const corrupt = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'message_start',
            message: { usage: { input_tokens: 1 } },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call:bad',
              name: 'read_file',
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{bad' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
    })
    await expect(collect(corrupt, input())).rejects.toThrow(
      'invalid tool input JSON',
    )
  })

  it('rejects provider error events and missing message_stop', async () => {
    const failed = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([{ type: 'error', error: { type: 'overloaded_error' } }]),
    })
    await expect(collect(failed, input())).rejects.toThrow(
      'Anthropic request failed',
    )

    const empty = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'message_start',
            message: { usage: { input_tokens: 1 } },
          },
          { type: 'message_stop' },
        ]),
    })
    await expect(collect(empty, input())).rejects.toThrow(
      'empty assistant turn',
    )

    const unterminated = new GenericAnthropicProvider({
      providerId: 'anthropic',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () => sseResponse([{ type: 'ping' }]),
    })
    await expect(collect(unterminated, input())).rejects.toThrow(
      'without message_stop',
    )
  })
})
