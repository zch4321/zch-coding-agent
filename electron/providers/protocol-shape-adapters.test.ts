import { describe, expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendPromptMessage,
  appendToolResult,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import {
  AnthropicShapeTestAdapter,
  ResponsesShapeTestAdapter,
} from './fixtures/protocol-shape-test-adapters'

const route: ModelRouteSnapshot = {
  schemaVersion: 1,
  purpose: 'main',
  adapterId: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'fixture',
  reasoning: 'off',
  endpoint: 'https://api.example/chat/completions',
  providerConfigRevision: 1,
}

function history(): CanonicalHistoryState {
  const state: CanonicalHistoryState = {
    sessionId: 'session:shape-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
  appendPromptMessage(state, {
    kind: 'system_instruction',
    content: 'system',
    source: 'test',
    trusted: true,
    editable: false,
  })
  appendAssistantTurn(state, {
    text: 'checking',
    route,
    toolCalls: [
      {
        id: 'call:first' as CallId,
        toolId: 'read_file',
        args: { path: 'a.txt' },
      },
      {
        id: 'call:second' as CallId,
        toolId: 'read_file',
        args: { path: 'b.txt' },
      },
    ],
  })
  for (const callId of ['call:first', 'call:second'] as const) {
    appendToolResult(state, {
      callId: callId as CallId,
      content: { ok: true },
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
  }
  return state
}

describe('test-only protocol shape adapters', () => {
  it('supports one canonical assistant turn becoming multiple wire items', () => {
    const compiled = new MessageHistoryCompiler().compile(history().history)
    const request = new ResponsesShapeTestAdapter().compile({
      history: compiled,
      route,
      tools: [],
    })

    expect(request.input.filter((item) => item.messageSeq === 2)).toHaveLength(
      3,
    )
  })

  it('supports multiple canonical tool results becoming one wire message', () => {
    const compiled = new MessageHistoryCompiler().compile(history().history)
    const request = new AnthropicShapeTestAdapter().compile({
      history: compiled,
      route,
      tools: [],
    })

    expect(request.messages).toHaveLength(3)
    expect(request.messages.at(-1)).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'tool_result', callId: 'call:first' },
        { type: 'tool_result', callId: 'call:second' },
      ],
    })
  })
})
