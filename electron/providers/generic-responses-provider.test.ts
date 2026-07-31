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
  GenericResponsesProvider,
  RESPONSES_CONTINUATION_FORMAT,
} from './generic-responses-provider'
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
    providerType: 'generic.responses',
    providerId: 'responses',
    model: 'gpt-test',
    reasoning,
    endpoint: 'https://api.example/v1/responses',
    providerConfigRevision: 1,
  }
}

function state(): CanonicalHistoryState {
  const sessionId = 'session:responses' as SessionId
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
    clientRequestId: 'request:responses',
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
    maxOutputTokens: 4_096,
  }
}

async function collect(
  provider: GenericResponsesProvider,
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

type TestResponsesPayload = JsonObject & { output: JsonObject[] }

function terminalResponse(
  status: 'completed' | 'incomplete' = 'completed',
): TestResponsesPayload {
  const output: JsonObject[] = [
    {
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Check the path.' }],
      encrypted_content: 'encrypted-reasoning',
    },
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'I will read it.', annotations: [] },
      ],
    },
    {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call:responses',
      name: 'read_file',
      arguments: '{"path":"README.md","_agent_intent":"inspect project"}',
      status: 'completed',
    },
  ]
  return {
    id: 'resp_1',
    object: 'response',
    status,
    output,
    ...(status === 'incomplete'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 28,
    },
  }
}

describe('GenericResponsesProvider', () => {
  it('compiles stateless Responses items, tools, reasoning and JSON Schema', () => {
    const provider = new GenericResponsesProvider({
      providerId: 'responses',
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
      model: 'gpt-test',
      instructions: 'System guidance',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: readTool().inputSchema,
          strict: false,
        },
      ],
      stream: true,
      store: false,
      max_output_tokens: 4_096,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      text: {
        format: {
          type: 'json_schema',
          name: 'approval',
          strict: true,
          schema: {
            type: 'object',
            properties: { decision: { type: 'string' } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      },
    })
    expect(call.request).not.toHaveProperty('previous_response_id')
  })

  it('streams reasoning, text and function arguments into one canonical turn', async () => {
    const response = terminalResponse()
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        {
          type: 'response.output_item.added',
          output_index: 2,
          item: {
            type: 'function_call',
            call_id: 'call:responses',
            name: 'read_file',
            arguments: '',
          },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          delta: 'Check the path.',
        },
        { type: 'response.output_text.delta', delta: 'I will read it.' },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 2,
          delta: '{"path":"README.md",',
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 2,
          delta: '"_agent_intent":"inspect project"}',
        },
        { type: 'response.completed', response },
      ]),
    ) as unknown as typeof fetch
    const provider = new GenericResponsesProvider({
      providerId: 'responses',
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
      'completed',
    ])
    const completed = events.at(-1)
    expect(completed?.type).toBe('completed')
    if (completed?.type !== 'completed') return
    expect(completed.turn).toMatchObject({
      parts: [
        { type: 'text', text: 'I will read it.' },
        {
          type: 'tool_call',
          callId: 'call:responses',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      toolCalls: [
        {
          id: 'call:responses',
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'inspect project',
        },
      ],
      normalizedReasoningText: 'Check the path.',
      usage: {
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        reasoningTokens: 3,
        cacheHitTokens: 4,
        cacheMissTokens: 16,
      },
      finishReason: 'tool_calls',
    })
    expect(completed.turn.providerContinuation).toMatchObject({
      providerType: 'generic.responses',
      format: RESPONSES_CONTINUATION_FORMAT,
      data: { outputItems: response.output },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example/v1/responses',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      }),
    )
  })

  it('replays matching output items and falls back when the hash changes', async () => {
    const response = terminalResponse()
    const provider = new GenericResponsesProvider({
      providerId: 'responses',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([{ type: 'response.completed', response }]),
    })
    const { events } = await collect(provider, input())
    const completed = events.at(-1)
    if (completed?.type !== 'completed') throw new Error('missing completion')
    const replayState = state()
    appendAssistantTurn(replayState, {
      text: 'I will read it.',
      toolCalls: [
        {
          id: 'call:responses' as CallId,
          toolId: 'read_file',
          args: { path: 'README.md' },
        },
      ],
      route: route(),
      continuation: completed.turn.providerContinuation,
    })
    appendToolResult(replayState, {
      callId: 'call:responses' as CallId,
      content: [
        { type: 'text', text: 'contents' },
        { type: 'json', value: { lines: 2 } },
      ],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const replay = provider.compile(input(replayState))
    expect(replay.request.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      },
      ...response.output,
      {
        type: 'function_call_output',
        call_id: 'call:responses',
        output: 'contents\n{"lines":2}',
      },
    ])
    const wireInput = JSON.stringify(replay.request.input)
    expect(wireInput).not.toContain('"status":"ok"')
    expect(wireInput).not.toContain('"type":"json"')
    expect(wireInput).not.toContain('"value":')
    expect(wireInput).not.toContain('"totalBytes"')

    const assistant = replayState.history.find(
      (record) => record.kind === 'assistant_turn',
    ) as Extract<MessageRecord, { kind: 'assistant_turn' }>
    if (!assistant.providerContinuation) throw new Error('missing continuation')
    const continuationData = structuredClone(
      assistant.providerContinuation.data,
    ) as JsonObject
    assistant.providerContinuation.data = {
      ...continuationData,
      outputItems: 'corrupt',
    }
    expect(() => provider.compile(input(replayState))).toThrow(
      'continuation output items are corrupt',
    )
    assistant.providerContinuation.data = {
      ...continuationData,
      partsHash: 'different',
    }
    const fallback = provider.compile(input(replayState))
    expect(fallback.request.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', role: 'assistant' }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call:responses',
        }),
      ]),
    )
  })

  it('normalizes incomplete output and rejects failed or unterminated streams', async () => {
    const incomplete = new GenericResponsesProvider({
      providerId: 'responses',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'response.incomplete',
            response: terminalResponse('incomplete'),
          },
        ]),
    })
    const result = await collect(incomplete, input())
    expect(result.events.at(-1)).toMatchObject({
      type: 'completed',
      turn: { finishReason: 'truncated' },
    })

    const failed = new GenericResponsesProvider({
      providerId: 'responses',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          { type: 'response.failed', response: { status: 'failed' } },
        ]),
    })
    await expect(collect(failed, input())).rejects.toThrow(
      'Responses request failed',
    )

    const empty = new GenericResponsesProvider({
      providerId: 'responses',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'response.completed',
            response: {
              id: 'resp_empty',
              status: 'completed',
              output: [],
              usage: {},
            },
          },
        ]),
    })
    await expect(collect(empty, input())).rejects.toThrow(
      'empty assistant turn',
    )

    const unterminated = new GenericResponsesProvider({
      providerId: 'responses',
      baseURL: 'https://api.example/v1',
      apiKey: 'secret',
      fetchImpl: async () =>
        sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]),
    })
    await expect(collect(unterminated, input())).rejects.toThrow(
      'without a terminal response',
    )
  })
})
