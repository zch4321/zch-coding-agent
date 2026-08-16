import { describe, expect, it } from 'vitest'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import { blankOverlay } from './agent-runtime-helpers'
import { projectConversationTurns } from './conversation-timeline'

const sessionId = 'session:timeline' as SessionId
const rootId = 'message:user' as MessageId
const timestamp = '2026-08-01T00:00:00.000Z'

function userMessage(): Extract<MessageRecord, { kind: 'user_input' }> {
  return {
    schemaVersion: 1,
    id: rootId,
    sessionId,
    seq: 1,
    visibility: 'visible',
    turnId: rootId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'user_input',
    clientRequestId: 'request:timeline',
    parts: [{ type: 'text', text: 'Inspect the workspace' }],
    metadata: {
      schemaVersion: 1,
      submission: { type: 'message' },
    },
  }
}

function assistantMessage(input: {
  id: string
  seq: number
  text?: string
  reasoning?: string
  tool?: { callId: CallId; name: string; args: JsonValue }
  visibility?: 'visible' | 'hidden'
  continuation?: boolean
}): Extract<MessageRecord, { kind: 'assistant_turn' }> {
  const parts: Extract<MessageRecord, { kind: 'assistant_turn' }>['parts'] = []
  if (input.text) parts.push({ type: 'text', text: input.text })
  if (input.tool) {
    parts.push({
      type: 'tool_call',
      callId: input.tool.callId,
      name: input.tool.name,
      arguments: input.tool.args,
    })
  }
  return {
    schemaVersion: 1,
    id: input.id as MessageId,
    sessionId,
    seq: input.seq,
    visibility: input.visibility ?? 'visible',
    turnId: rootId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'assistant_turn',
    parts,
    ...(input.reasoning ? { normalizedReasoningText: input.reasoning } : {}),
    ...(input.continuation
      ? {
          providerContinuation: {
            schemaVersion: 2,
            providerType: 'generic.responses',
            format: 'responses-output-items-v1',
            data: {
              outputItems: [
                { type: 'reasoning', encrypted_content: 'ciphertext' },
              ],
            },
          },
        }
      : {}),
    modelRoute: {
      schemaVersion: 2,
      purpose: 'main',
      providerType: 'deepseek.chat-completions',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'high',
      endpoint: 'https://provider.invalid/v1/chat/completions',
      providerConfigRevision: 1,
    },
  }
}

function toolResult(input: {
  id: string
  seq: number
  callId: CallId
  name: string
}): Extract<MessageRecord, { kind: 'tool_result' }> {
  return {
    schemaVersion: 1,
    id: input.id as MessageId,
    sessionId,
    seq: input.seq,
    visibility: 'visible',
    turnId: rootId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'tool_result',
    parts: [
      {
        type: 'tool_result',
        callId: input.callId,
        content: [{ type: 'json', value: { status: 'ok' } }],
        isError: false,
      },
    ],
    metadata: {
      schemaVersion: 1,
      tool: {
        name: input.name,
        reason: 'Inspect the requested resource',
        status: 'completed',
        truncated: false,
      },
    },
  }
}

function interjection(seq: number): MessageRecord {
  return {
    schemaVersion: 1,
    id: 'message:interjection' as MessageId,
    sessionId,
    seq,
    visibility: 'visible',
    turnId: rootId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'interjection',
    parts: [{ type: 'text', text: 'Also check the tests' }],
    metadata: {
      schemaVersion: 1,
      layer: {
        source: 'run.interjection',
        trusted: false,
        editable: false,
        hash: 'a'.repeat(64),
      },
      interjectionId: 'interjection:timeline',
    },
  }
}

function orchestration(input: {
  id: string
  seq: number
  source: string
  text: string
}): MessageRecord {
  return {
    schemaVersion: 1,
    id: input.id as MessageId,
    sessionId,
    seq: input.seq,
    visibility: 'visible',
    turnId: rootId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'orchestrator',
    parts: [{ type: 'text', text: input.text }],
    metadata: {
      schemaVersion: 1,
      layer: {
        source: input.source,
        trusted: false,
        editable: false,
        hash: 'a'.repeat(64),
      },
    },
  }
}

describe('projectConversationTurns', () => {
  it('hides legacy visible Swarm prompts without hiding other orchestration', () => {
    const turns = projectConversationTurns({
      records: [
        userMessage(),
        orchestration({
          id: 'message:swarm-orchestration',
          seq: 2,
          source: 'slash:/swarm',
          text: 'Internal Swarm prompt',
        }),
        orchestration({
          id: 'message:goal-orchestration',
          seq: 3,
          source: 'slash:/goal',
          text: 'Visible goal orchestration',
        }),
        assistantMessage({
          id: 'message:assistant-after-orchestration',
          seq: 4,
          text: 'Done',
        }),
      ],
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.messages.map((message) => message.text)).toEqual([
      'Visible goal orchestration',
      'Done',
    ])
  })

  it('groups every ReAct step under one user turn by display category', () => {
    const readCallId = 'call:read' as CallId
    const turns = projectConversationTurns({
      records: [
        userMessage(),
        assistantMessage({
          id: 'message:assistant-tool',
          seq: 2,
          reasoning: 'I should inspect the file.',
          tool: {
            callId: readCallId,
            name: 'read_file',
            args: { path: 'a.ts' },
          },
        }),
        toolResult({
          id: 'message:tool-result',
          seq: 3,
          callId: readCallId,
          name: 'read_file',
        }),
        assistantMessage({
          id: 'message:assistant-update',
          seq: 4,
          reasoning: 'The file points to the relevant test.',
          text: 'I found the implementation.',
        }),
        assistantMessage({
          id: 'message:assistant-final',
          seq: 5,
          text: 'The behavior is covered by tests.',
        }),
      ],
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.userMessage?.text).toBe('Inspect the workspace')
    expect(turns[0]?.tools).toEqual([
      expect.objectContaining({
        callId: readCallId,
        tool: 'read_file',
        status: 'completed',
        order: 2,
      }),
    ])
    expect(turns[0]?.reasoningSegments.map((segment) => segment.text)).toEqual([
      'I should inspect the file.',
      'The file points to the relevant test.',
    ])
    expect(turns[0]?.messages.map((message) => message.text)).toEqual([
      'I found the implementation.',
      'The behavior is covered by tests.',
    ])
    expect(turns[0]?.finalAssistantMessageId).toBe('message:assistant-final')
  })

  it('omits hidden and encrypted reasoning while retaining plaintext-only turns', () => {
    const turns = projectConversationTurns({
      records: [
        userMessage(),
        assistantMessage({
          id: 'message:encrypted',
          seq: 2,
          text: 'Visible answer',
          continuation: true,
        }),
        assistantMessage({
          id: 'message:hidden',
          seq: 3,
          reasoning: 'Hidden reasoning',
          text: 'Hidden answer',
          visibility: 'hidden',
        }),
        assistantMessage({
          id: 'message:reasoning-only',
          seq: 4,
          reasoning: 'Plaintext summary',
          tool: {
            callId: 'call:reasoning-only' as CallId,
            name: 'search',
            args: {},
          },
        }),
      ],
    })

    expect(turns[0]?.reasoningSegments.map((segment) => segment.text)).toEqual([
      'Plaintext summary',
    ])
    expect(turns[0]?.messages.map((message) => message.text)).toEqual([
      'Visible answer',
    ])
  })

  it('renders a partial tool result page and deduplicates its live tool copy', () => {
    const callId = 'call:partial' as CallId
    const overlay = blankOverlay()
    overlay.runId = 'run:timeline' as RunId
    overlay.status = 'running_tools'
    overlay.reasoning = 'Live reasoning'
    overlay.text = 'Live answer'
    overlay.tools = [
      {
        callId,
        runId: overlay.runId,
        tool: 'wrong-live-copy',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
      {
        callId: 'call:live' as CallId,
        runId: overlay.runId,
        tool: 'shell_command',
        args: { command: 'npm test' },
        reason: 'Run tests',
        status: 'proposed',
        order: 3,
      },
    ]

    const turns = projectConversationTurns({
      records: [
        toolResult({
          id: 'message:partial-result',
          seq: 10,
          callId,
          name: 'read_file',
        }),
      ],
      overlay,
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.id).toContain('continuation')
    expect(turns[0]?.tools.map((tool) => tool.tool)).toEqual([
      'read_file',
      'shell_command',
    ])
    expect(turns[0]?.reasoningSegments.at(-1)).toMatchObject({
      text: 'Live reasoning',
      live: true,
    })
    expect(turns[0]?.messages.at(-1)).toMatchObject({
      text: 'Live answer',
      live: true,
    })
  })

  it('starts a new display turn at a durable interjection boundary', () => {
    const firstCallId = 'call:first' as CallId
    const turns = projectConversationTurns({
      records: [
        userMessage(),
        assistantMessage({
          id: 'message:first-tool',
          seq: 2,
          tool: { callId: firstCallId, name: 'read_file', args: {} },
        }),
        toolResult({
          id: 'message:first-result',
          seq: 3,
          callId: firstCallId,
          name: 'read_file',
        }),
        interjection(4),
        assistantMessage({
          id: 'message:after-interjection',
          seq: 5,
          reasoning: 'Now inspect the tests.',
          text: 'The tests confirm it.',
        }),
      ],
    })

    expect(turns).toHaveLength(2)
    expect(turns[0]?.tools).toHaveLength(1)
    expect(turns[0]?.finalAssistantMessageId).toBeUndefined()
    expect(turns[1]?.userMessage).toMatchObject({
      role: 'interjection',
      text: 'Also check the tests',
    })
    expect(turns[1]?.reasoningSegments).toHaveLength(1)
    expect(turns[1]?.messages.map((message) => message.text)).toEqual([
      'The tests confirm it.',
    ])
    expect(turns[1]?.finalAssistantMessageId).toBe('message:after-interjection')
  })
})
