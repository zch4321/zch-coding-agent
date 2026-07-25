import { describe, expect, it } from 'vitest'
import type { CallId, MessageId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendCompactSummary,
  appendPromptMessage,
  appendToolResult,
  appendUserInput,
  canonicalHash,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { ChatCompletionsAdapter } from './chat-completions-adapter'
import type { ProviderEvent } from './provider'

const route: ModelRouteSnapshot = {
  schemaVersion: 1,
  purpose: 'main',
  adapterId: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'high',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 3,
}

function state(): CanonicalHistoryState {
  return {
    sessionId: 'session:adapter-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
}

function system(history: CanonicalHistoryState): void {
  appendPromptMessage(history, {
    kind: 'system_instruction',
    content: 'system',
    source: 'test:system',
    trusted: true,
    editable: false,
  })
}

function completed(
  overrides: Partial<Extract<ProviderEvent, { type: 'completed' }>> = {},
): Extract<ProviderEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rawResponse: { id: 'response' },
    turn: { role: 'assistant', content: 'done' },
    toolCalls: [],
    usage: { total_tokens: 4 },
    providerState: {},
    timing: {},
    ...overrides,
  }
}

describe('ChatCompletionsAdapter', () => {
  it('maps canonical text, reasoning, tool calls and results to wire DTOs', () => {
    const history = state()
    system(history)
    appendUserInput(history, {
      content: 'read',
      clientRequestId: 'request:read',
    })
    appendAssistantTurn(history, {
      text: 'checking',
      reasoning: 'need file',
      route,
      toolCalls: [
        {
          id: 'call:read' as CallId,
          toolId: 'read_file',
          args: { path: 'README.md' },
        },
      ],
    })
    appendToolResult(history, {
      callId: 'call:read' as CallId,
      content: { text: 'README' },
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const adapter = new ChatCompletionsAdapter(route.adapterId)
    const request = adapter.compile({
      history: new MessageHistoryCompiler().compile(history.history),
      route,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            'x-agent-intent-property': '_intent',
          },
        },
      ],
    })

    expect(request.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'read' },
      {
        role: 'assistant',
        content: 'checking',
        reasoning_content: 'need file',
        tool_calls: [
          {
            id: 'call:read',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call:read',
        content: JSON.stringify([{ type: 'json', value: { text: 'README' } }]),
      },
    ])
    expect(JSON.stringify(request.body)).not.toContain(
      'x-agent-intent-property',
    )
    expect(request.body).toMatchObject({
      model: route.model,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('emits automatic compact summary as the final user continuation', () => {
    const history = state()
    history.nextMessageSeq = 10
    system(history)
    appendPromptMessage(history, {
      kind: 'runtime_context',
      content: 'runtime',
      source: 'test:runtime',
      trusted: true,
      editable: false,
    })
    appendUserInput(history, {
      content: 'root request',
      replayedFromMessageId: 'message:root' as MessageId,
    })
    appendCompactSummary(history, {
      content: '<compact_history>checkpoint</compact_history>',
      replacesThroughSeq: 9,
      sourceHash: 'a'.repeat(64),
    })
    const request = new ChatCompletionsAdapter(route.adapterId).compile({
      history: new MessageHistoryCompiler().compile(history.history),
      route,
      tools: [],
    })

    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: '<compact_history>checkpoint</compact_history>',
    })
  })

  it('restores compatible continuation and rebuilds incompatible or mismatched data', () => {
    const history = state()
    system(history)
    const parts = [
      {
        type: 'tool_call' as const,
        callId: 'call:raw' as CallId,
        name: 'read_file',
        arguments: { path: 'canonical.md' },
      },
    ]
    const assistant = appendAssistantTurn(history, {
      text: '',
      reasoning: 'normalized',
      route,
      toolCalls: [
        {
          id: 'call:raw' as CallId,
          toolId: 'read_file',
          args: { path: 'canonical.md' },
        },
      ],
      continuation: {
        schemaVersion: 1,
        adapterId: route.adapterId,
        format: 'chat-completions.assistant.v1',
        data: {
          partsHash: canonicalHash(parts),
          assistant: {
            role: 'assistant',
            content: null,
            reasoning_content: 'provider-native',
            tool_calls: [{ provider_specific: true }],
          },
        },
      },
    })
    appendToolResult(history, {
      callId: 'call:raw' as CallId,
      content: {},
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    const adapter = new ChatCompletionsAdapter(route.adapterId)
    const compatible = adapter.compile({
      history: new MessageHistoryCompiler().compile(history.history),
      route,
      tools: [],
    })
    expect(compatible.messages[1]).toMatchObject({
      reasoning_content: 'provider-native',
      tool_calls: [{ provider_specific: true }],
    })

    assistant.providerContinuation!.data = {
      partsHash: 'b'.repeat(64),
      assistant: { corrupt: true },
    }
    const mismatched = adapter.compile({
      history: new MessageHistoryCompiler().compile(history.history),
      route,
      tools: [],
    })
    expect(mismatched.messages[1]).toMatchObject({
      reasoning_content: 'normalized',
      tool_calls: [
        {
          function: {
            arguments: '{"path":"canonical.md"}',
          },
        },
      ],
    })

    assistant.providerContinuation!.format = 'other-format'
    expect(
      adapter.compile({
        history: new MessageHistoryCompiler().compile(history.history),
        route,
        tools: [],
      }).messages[1],
    ).toMatchObject({ reasoning_content: 'normalized' })
  })

  it('rejects corrupt matching continuation before transport', () => {
    const history = state()
    system(history)
    const assistant = appendAssistantTurn(history, {
      text: 'canonical',
      route,
      toolCalls: [],
    })
    assistant.providerContinuation = {
      schemaVersion: 1,
      adapterId: route.adapterId,
      format: 'chat-completions.assistant.v1',
      data: {
        partsHash: canonicalHash(assistant.parts),
        assistant: { role: 'assistant' },
      },
    }

    expect(() =>
      new ChatCompletionsAdapter(route.adapterId).compile({
        history: new MessageHistoryCompiler().compile(history.history),
        route,
        tools: [],
      }),
    ).toThrow('corrupt')
  })

  it('normalizes completion text, streamed reasoning, tools, usage and finish reason', () => {
    const event = completed({
      turn: {
        role: 'assistant',
        content: null,
        tool_calls: [{ native: true } as JsonValue],
      },
      toolCalls: [
        {
          id: 'call:tool' as CallId,
          toolId: 'read_file',
          args: { path: 'README.md' },
          reason: 'inspect',
        },
      ],
    })
    const result = new ChatCompletionsAdapter(route.adapterId).complete(event, {
      text: 'streamed text',
      reasoning: 'streamed reasoning',
    })

    expect(result).toMatchObject({
      parts: [
        { type: 'text', text: 'streamed text' },
        {
          type: 'tool_call',
          callId: 'call:tool',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      normalizedReasoningText: 'streamed reasoning',
      usage: { total_tokens: 4 },
      finishReason: 'tool_calls',
    })
  })

  it('normalizes provider truncation and content-filter finish reasons', () => {
    const adapter = new ChatCompletionsAdapter(route.adapterId)

    expect(
      adapter.complete(completed({ finishReason: 'length' })),
    ).toMatchObject({
      finishReason: 'truncated',
    })
    expect(
      adapter.complete(completed({ finishReason: 'content_filter' })),
    ).toMatchObject({
      finishReason: 'content_filter',
    })
  })

  it('treats reasoning-only completion as a retryable request failure', () => {
    const adapter = new ChatCompletionsAdapter(route.adapterId)

    expect(() =>
      adapter.complete(
        completed({
          turn: {
            role: 'assistant',
            content: null,
            reasoning_content: 'Unfinished reasoning',
          },
          finishReason: 'length',
        }),
      ),
    ).toThrow(
      'Provider returned reasoning without an assistant answer; retry the request',
    )
  })
})
