import { describe, expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { CanonicalPromptKind } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendCompactSummary,
  appendControlCommand,
  appendPromptMessage,
  appendToolResult,
  appendUserInput,
  assertAssistantTurnCandidate,
  deactivateActiveHistory,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from './canonical-history'

const route: ModelRouteSnapshot = {
  schemaVersion: 1,
  purpose: 'main',
  adapterId: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'high',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}

function state(): CanonicalHistoryState {
  return {
    sessionId: 'session:canonical-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
}

function prompt(
  history: CanonicalHistoryState,
  kind: CanonicalPromptKind = 'system_instruction',
) {
  return appendPromptMessage(history, {
    kind,
    content: kind,
    source: `test:${kind}`,
    trusted: kind === 'system_instruction',
    editable: false,
  })
}

describe('MessageHistoryCompiler', () => {
  it('rejects blank user input before it reaches canonical history', () => {
    expect(() =>
      appendUserInput(state(), {
        content: ' \n ',
        clientRequestId: 'request:blank',
      }),
    ).toThrow(/must not be empty/u)
  })

  it('compiles every prompt kind and ordinary text in strict seq order', () => {
    const history = state()
    const kinds: CanonicalPromptKind[] = [
      'system_instruction',
      'assistant_preferences',
      'selected_context',
      'benchmark_context',
      'runtime_context',
      'agents_context',
      'orchestrator',
      'interjection',
    ]
    for (const kind of kinds) prompt(history, kind)
    appendUserInput(history, {
      content: 'hello',
      clientRequestId: 'request:original',
    })
    const compiled = new MessageHistoryCompiler().compile(history.history)

    expect(compiled.messages.map((message) => message.kind)).toEqual([
      ...kinds,
      'user_input',
    ])
    expect(compiled.sourceHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(
      new MessageHistoryCompiler().compile(structuredClone(history.history))
        .sourceHash,
    ).toBe(compiled.sourceHash)
  })

  it('keeps control commands outside history and identifies derived payloads', () => {
    const history = state()
    const command = appendControlCommand(history, {
      content: '/compact focus on risks',
      clientRequestId: 'request:compact',
      requestHash: 'a'.repeat(64),
      command: 'compact',
    })
    const derived = appendUserInput(history, {
      content: 'focus on risks',
      derivedFromMessageId: command.id,
    })

    expect(command).toMatchObject({
      inHistory: false,
      metadata: {
        submission: { type: 'control_command', command: 'compact' },
      },
    })
    expect(derived).toMatchObject({
      inHistory: true,
      metadata: {
        derivedFromMessageId: command.id,
        derivation: 'control_command_payload',
      },
    })
    expect('clientRequestId' in derived).toBe(false)
  })

  it('accepts reasoning plus an ordered multi-tool result batch', () => {
    const history = state()
    prompt(history)
    appendUserInput(history, {
      content: 'read both',
      clientRequestId: 'request:tools',
    })
    appendAssistantTurn(history, {
      text: '',
      reasoning: 'Need both files.',
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
    for (const [callId, name] of [
      ['call:first', 'a.txt'],
      ['call:second', 'b.txt'],
    ] as const) {
      appendToolResult(history, {
        callId: callId as CallId,
        content: { path: name },
        isError: false,
        name: 'read_file',
        status: 'completed',
        truncated: false,
      })
    }

    expect(
      new MessageHistoryCompiler().compile(history.history).messages,
    ).toHaveLength(5)
  })

  it('rejects a tool call id already used in the active epoch', () => {
    const history = state()
    prompt(history)
    appendAssistantTurn(history, {
      text: '',
      route,
      toolCalls: [
        {
          id: 'call:epoch-duplicate' as CallId,
          toolId: 'read_file',
          args: { path: 'a.txt' },
        },
      ],
    })
    appendToolResult(history, {
      callId: 'call:epoch-duplicate' as CallId,
      content: { path: 'a.txt' },
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })

    expect(() =>
      assertAssistantTurnCandidate(history, {
        parts: [
          {
            type: 'tool_call',
            callId: 'call:epoch-duplicate' as CallId,
            name: 'read_file',
            arguments: { path: 'b.txt' },
          },
        ],
        route,
      }),
    ).toThrow(/Duplicate tool call id in active history/u)
  })

  it('validates the entire assistant candidate before changing state', () => {
    const history = state()
    prompt(history)
    const before = structuredClone(history)

    expect(() =>
      assertAssistantTurnCandidate(history, {
        parts: Array.from({ length: 257 }, (_value, index) => ({
          type: 'tool_call' as const,
          callId: `call:too-many:${index}` as CallId,
          name: 'read_file',
          arguments: { path: `${index}.txt` },
        })),
        route,
      }),
    ).toThrow(/Canonical assistant completion is invalid/u)
    expect(history).toEqual(before)
  })

  it.each([
    ['missing', ['call:first']],
    ['duplicate', ['call:first', 'call:first']],
    ['out-of-order', ['call:second', 'call:first']],
  ])('rejects %s tool results', (_label, results) => {
    const history = state()
    prompt(history)
    appendAssistantTurn(history, {
      text: '',
      route,
      toolCalls: [
        {
          id: 'call:first' as CallId,
          toolId: 'read_file',
          args: {},
        },
        {
          id: 'call:second' as CallId,
          toolId: 'read_file',
          args: {},
        },
      ],
    })
    for (const callId of results) {
      appendToolResult(history, {
        callId: callId as CallId,
        content: {},
        isError: false,
        name: 'read_file',
        status: 'completed',
        truncated: false,
      })
    }

    expect(() =>
      new MessageHistoryCompiler().compile(history.history),
    ).toThrow()
  })

  it('rejects a result that crosses into another assistant batch', () => {
    const history = state()
    prompt(history)
    appendAssistantTurn(history, {
      text: '',
      route,
      toolCalls: [
        {
          id: 'call:first' as CallId,
          toolId: 'read_file',
          args: {},
        },
      ],
    })
    appendAssistantTurn(history, {
      text: 'started another turn',
      route,
      toolCalls: [],
    })
    appendToolResult(history, {
      callId: 'call:first' as CallId,
      content: {},
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })

    expect(() => new MessageHistoryCompiler().compile(history.history)).toThrow(
      'terminal results',
    )
  })

  it('validates session, identity order, and compact epoch boundaries', () => {
    const history = state()
    prompt(history)
    appendUserInput(history, {
      content: 'old',
      clientRequestId: 'request:old',
    })
    const old = deactivateActiveHistory(history)
    prompt(history)
    appendCompactSummary(history, {
      content: 'checkpoint',
      replacesThroughSeq: old.at(-1)!.seq,
      sourceHash: 'a'.repeat(64),
    })
    expect(() =>
      new MessageHistoryCompiler().compile(history.history),
    ).not.toThrow()

    const active = history.history.filter((message) => message.inHistory)
    const compact = active[1]
    if (compact?.kind !== 'compact_summary') {
      throw new Error('Expected compact summary fixture')
    }
    compact.metadata.compact.replacesThroughSeq = active[0]!.seq
    expect(() => new MessageHistoryCompiler().compile(history.history)).toThrow(
      'boundary',
    )
  })
})
