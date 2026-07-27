import { describe, expect, it } from 'vitest'
import type { CallId, EventId, RunId, SessionId } from '../../shared/ids'
import type { TraceId } from '../../shared/trace'
import { createTraceEvent, type TraceEventInput } from './events'
import {
  normalizeSessionTranscript,
  omitMultimodalContent,
  sessionTranscriptToMarkdown,
} from './session-transcript'

const sessionId = 'session-transcript' as SessionId
const runId = 'run-transcript' as RunId
const callId = 'call-tool' as CallId
const llmCallId = 'call-llm' as CallId
const traceId = 'session-transcript' as TraceId
const modelRoute = {
  schemaVersion: 2 as const,
  purpose: 'main' as const,
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'fixture',
  reasoning: 'off' as const,
  endpoint: 'https://api.example/chat/completions',
  providerConfigRevision: 1,
}

function trace(inputs: TraceEventInput[]) {
  return inputs.map((input, index) =>
    createTraceEvent(
      input,
      index + 1,
      `event-${index + 1}` as EventId,
      new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString(),
    ),
  )
}

describe('session transcript', () => {
  it('normalizes private orchestration, reasoning, tools and provider context', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'yolo',
      },
      { type: 'run.start', sessionId, runId },
      {
        type: 'orchestrator.message',
        sessionId,
        runId,
        kind: 'test_context',
        text: '{"allowedPaths":["src/**"]}',
      },
      { type: 'user.message', sessionId, runId, text: 'fix it' },
      {
        type: 'llm.request',
        sessionId,
        runId,
        callId: llmCallId,
        normalizedMessages: [
          { role: 'system', content: 'system instructions' },
          {
            role: 'user',
            content: 'data:image/png;base64,aGVsbG8=',
          },
        ],
        providerRequest: { tools: [{ secretSchema: true }] },
        requestBytes: 123,
        prefixHash: 'prefix',
        canonicalSource: [],
        modelRoute,
      },
      {
        type: 'agent.message',
        sessionId,
        runId,
        text: 'I will patch it.',
        reasoning: 'Plain reasoning.',
      },
      {
        type: 'tool.proposed',
        sessionId,
        runId,
        callId,
        tool: 'mcp:server:write',
        args: { path: 'src/a.ts' },
        reason: 'Apply the fix',
      },
      {
        type: 'approval',
        sessionId,
        runId,
        callId,
        policySignals: [{ code: 'review' }],
        mode: 'confirm',
        approver: 'human',
        decision: 'approved',
        reason: 'User approved',
      },
      {
        type: 'tool.attempt',
        sessionId,
        runId,
        callId,
        tool: 'mcp:server:write',
        stage: 'execution',
        outcome: 'succeeded',
        effects: ['filesystem.write'],
        durationMs: 12,
        inputBytes: 10,
        outputBytes: 20,
        truncated: false,
      },
      {
        type: 'tool.call',
        sessionId,
        runId,
        callId,
        tool: 'mcp:server:write',
        args: { path: 'src/a.ts' },
        reason: 'Apply the fix',
        result: {
          status: 'ok',
          content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        },
        approvedBy: 'human',
        policySignals: [{ code: 'review' }],
        durationMs: 12,
      },
      {
        type: 'llm.response',
        sessionId,
        runId,
        callId: llmCallId,
        rawResponse: { encrypted_reasoning: 'ciphertext-must-not-export' },
        normalizedTurn: { role: 'assistant', content: 'I will patch it.' },
        providerState: { encrypted: 'opaque-state-must-not-export' },
        usage: { total_tokens: 10 },
        timing: { totalMs: 20 },
      },
      { type: 'run.end', sessionId, runId, status: 'completed' },
      { type: 'session.end', sessionId },
    ])

    const document = normalizeSessionTranscript(events, {
      traceId,
      revision: 'a'.repeat(64),
      generatedAt: '2026-07-12T00:01:00.000Z',
    })
    expect(document.metadata).toMatchObject({
      active: false,
    })
    expect(document.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'orchestrator',
        'user',
        'provider_request',
        'reasoning',
        'assistant',
        'tool',
        'provider_response',
      ]),
    )
    const tool = document.entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      categories: ['tool', 'approval'],
      title: 'mcp:server:write · succeeded',
    })
    expect(JSON.stringify(tool?.data)).toContain('multimodal_content_omitted')
    expect(JSON.stringify(tool?.data)).not.toContain('aGVsbG8=')
    const requestMessages = document.requestMessages.get('event-5')
    expect(JSON.stringify(requestMessages)).toContain(
      'multimodal content omitted',
    )

    const markdown = sessionTranscriptToMarkdown(document)
    expect(markdown).toContain('format: "zch-session-transcript"')
    expect(markdown).toContain('Plain reasoning.')
    expect(markdown).toContain('<details>')
    expect(markdown).toContain('system instructions')
    expect(markdown).not.toContain('ciphertext-must-not-export')
    expect(markdown).not.toContain('opaque-state-must-not-export')
    expect(markdown).not.toContain('secretSchema')
  })

  it('emits interrupted plaintext deltas as partial entries', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'auto',
      },
      {
        type: 'llm.stream',
        sessionId,
        runId,
        callId: llmCallId,
        providerEvent: { type: 'reasoning.delta', delta: 'Need to inspect.' },
        elapsedMs: 1,
      },
      {
        type: 'llm.stream',
        sessionId,
        runId,
        callId: llmCallId,
        providerEvent: { type: 'text.delta', delta: 'Partial answer' },
        elapsedMs: 2,
      },
    ])
    const document = normalizeSessionTranscript(events, {
      traceId,
      revision: 'revision',
      generatedAt: '2026-07-12T00:01:00.000Z',
    })
    expect(document.entries.filter((entry) => entry.partial)).toMatchObject([
      { kind: 'assistant', text: 'Partial answer' },
      { kind: 'reasoning', text: 'Need to inspect.' },
    ])
  })

  it('keeps denied model approval and permission-stage failure in one tool entry', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'auto',
      },
      {
        type: 'tool.proposed',
        sessionId,
        runId,
        callId,
        tool: 'run_command',
        args: { command: 'dangerous' },
        reason: 'Run a command',
      },
      {
        type: 'approval',
        sessionId,
        runId,
        callId,
        policySignals: [{ code: 'danger' }],
        mode: 'auto',
        approver: 'model',
        decision: 'dangerous',
        reason: 'Unsafe command',
      },
      {
        type: 'tool.attempt',
        sessionId,
        runId,
        callId,
        tool: 'run_command',
        stage: 'permission',
        outcome: 'denied',
        effects: ['process.spawn'],
        durationMs: 5,
        inputBytes: 10,
        outputBytes: 10,
        truncated: false,
      },
      {
        type: 'tool.call',
        sessionId,
        runId,
        callId,
        tool: 'run_command',
        args: { command: 'dangerous' },
        result: { status: 'denied', message: 'Denied' },
        approvedBy: 'none',
        policySignals: [{ code: 'danger' }],
        durationMs: 5,
      },
    ])
    const document = normalizeSessionTranscript(events, {
      traceId,
      revision: 'revision',
      generatedAt: '2026-07-12T00:01:00.000Z',
    })
    const tool = document.entries.find((entry) => entry.kind === 'tool')
    expect(tool).toMatchObject({
      categories: ['tool', 'approval'],
      title: 'run_command · denied',
      data: {
        stage: 'permission',
        outcome: 'denied',
        approval: {
          approver: 'model',
          decision: 'dangerous',
        },
      },
    })
  })

  it('uses a fence longer than any backtick run in raw text', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
      {
        type: 'user.message',
        sessionId,
        text: '# heading\n```ts\nconst value = 1\n```',
      },
    ])
    const markdown = sessionTranscriptToMarkdown(
      normalizeSessionTranscript(events, {
        traceId,
        revision: 'revision',
        generatedAt: '2026-07-12T00:01:00.000Z',
      }),
    )
    expect(markdown).toContain('````text')
    expect(markdown).toContain('# heading\n```ts')
  })

  it('does not alter ordinary JSON while omitting known media blocks', () => {
    expect(omitMultimodalContent({ type: 'file', path: 'src/a.ts' })).toEqual({
      type: 'file',
      path: 'src/a.ts',
    })
    expect(
      omitMultimodalContent({ type: 'image_query', query: 'architecture' }),
    ).toEqual({ type: 'image_query', query: 'architecture' })
    expect(
      omitMultimodalContent({
        type: 'audio',
        mime_type: 'audio/wav',
        base64: 'aGVsbG8=',
      }),
    ).toMatchObject({ type: 'multimodal_content_omitted' })
  })
})
