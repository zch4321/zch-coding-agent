import { describe, expect, it } from 'vitest'
import type { CallId, EventId, RunId, SessionId } from '../../shared/ids'
import { createTraceEvent, type TraceEventInput } from './events'
import { createReplayTimeline, replayTrace, reduceTraceEvent } from './replay'

const sessionId = 'session-replay' as SessionId
const runId = 'run-replay' as RunId
const callId = 'call-replay' as CallId

function trace(
  inputs: TraceEventInput[],
  start = Date.parse('2026-06-15T00:00:00.000Z'),
) {
  return inputs.map((input, index) =>
    createTraceEvent(
      input,
      index + 1,
      `event-${index + 1}` as EventId,
      new Date(start + index * 100).toISOString(),
    ),
  )
}

describe('trace replay', () => {
  it('deterministically replays messages and run state', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'deepseek-chat',
        mode: 'readonly',
      },
      { type: 'session.mode', sessionId, mode: 'auto' },
      { type: 'run.start', sessionId, runId },
      { type: 'user.message', sessionId, runId, text: 'hello' },
      {
        type: 'llm.stream',
        sessionId,
        runId,
        callId,
        providerEvent: { type: 'text.delta', delta: 'hi' },
        elapsedMs: 10,
      },
      {
        type: 'agent.message',
        sessionId,
        runId,
        text: 'hi',
      },
      {
        type: 'run.end',
        sessionId,
        runId,
        status: 'completed',
      },
      { type: 'session.end', sessionId },
    ])

    const first = replayTrace(events)
    const second = replayTrace(events)

    expect(second).toEqual(first)
    expect(first.messages).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'agent', text: 'hi', reasoning: undefined },
    ])
    expect(first.runs[runId]).toBe('completed')
    expect(first.mode).toBe('auto')
    expect(first.closed).toBe(true)
    expect(first.agentEvents.map((event) => event.type)).toEqual([
      'run.status',
      'assistant.text.delta',
      'run.status',
      'session.closed',
    ])
  })

  it('replays approvals and tools and applies timeline speed', () => {
    const events = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'deepseek-chat',
        mode: 'auto',
      },
      {
        type: 'approval',
        sessionId,
        runId,
        callId,
        policySignals: [],
        mode: 'auto',
        approver: 'human',
        decision: 'allow',
        reason: 'approved',
      },
      {
        type: 'tool.call',
        sessionId,
        runId,
        callId,
        tool: 'read_file',
        args: { path: 'README.md' },
        result: { status: 'ok', content: 'text' },
        approvedBy: 'readonly',
        policySignals: [],
        durationMs: 3,
      },
    ])
    const state = replayTrace(events)
    const timeline = createReplayTimeline(events, 2)

    expect(state.approvals[0]).toMatchObject({ decision: 'allow' })
    expect(state.tools[callId]?.tool).toBe('read_file')
    expect(timeline.map((item) => item.delayMs)).toEqual([0, 50, 50])
  })

  it('skips future events only when configured and rejects sequence rollback', () => {
    const future = { schemaVersion: 2, seq: 1, type: 'future.event' }
    const skipped = reduceTraceEvent(
      {
        schemaVersion: 1,
        lastSeq: 0,
        skippedEvents: 0,
        closed: false,
        runs: {},
        messages: [],
        tools: {},
        approvals: [],
        terminals: {},
        agentEvents: [],
      },
      future,
      { unknownEvent: 'skip' },
    )

    expect(skipped.skippedEvents).toBe(1)
    expect(() => replayTrace([future])).toThrow()

    const duplicate = trace([
      {
        type: 'session.start',
        sessionId,
        workspace: 'workspace',
        model: 'model',
        mode: 'readonly',
      },
    ])[0]
    const state = replayTrace([duplicate])
    expect(() => reduceTraceEvent(state, duplicate)).toThrow(
      'strictly increasing',
    )
  })
})
