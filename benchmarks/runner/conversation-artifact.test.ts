import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../electron/logging/events'
import { markdownToConversation } from '../../shared/conversation-markdown'
import { benchmarkConversationMarkdown } from './conversation-artifact'

describe('benchmark conversation artifact', () => {
  it('reuses the Electron markdown format for user, harness, and assistant messages', () => {
    const trace = [
      event('session.start', 1, {
        workspace: '/workspace',
        model: 'model',
        mode: 'yolo',
      }),
      event('orchestrator.message', 2, {
        runId: 'run-1',
        kind: 'benchmark_case',
        text: '{"allowedPaths":["src/**"]}',
      }),
      event('user.message', 3, {
        runId: 'run-1',
        text: 'Fix the implementation',
      }),
      event('agent.message', 4, {
        runId: 'run-1',
        text: 'Implemented the fix.',
        reasoning: 'Checked the public behavior.',
      }),
      event('tool.call', 5, {
        runId: 'run-1',
        callId: 'call-1',
        tool: 'run_command',
        args: { command: 'npm test' },
        result: { status: 'ok' },
        approvedBy: 'yolo',
        policySignals: [],
        durationMs: 1,
      }),
      event('session.end', 6, {}),
    ] as TraceEvent[]

    const markdown = benchmarkConversationMarkdown({
      trace,
      caseId: 'case-one',
    })
    const parsed = markdownToConversation(markdown)

    expect(markdown).toContain('format: "zch-conversation"')
    expect(markdown).toContain('title: "Benchmark: case-one"')
    expect(parsed.messages.map((message) => message.role)).toEqual([
      'orchestrator',
      'user',
      'assistant',
    ])
    expect(parsed.messages[0]?.text).toContain('allowedPaths')
    expect(parsed.messages[2]?.reasoning).toBe('Checked the public behavior.')
    expect(markdown).not.toContain('run_command')
  })
})

function event(
  type: TraceEvent['type'],
  seq: number,
  fields: Record<string, unknown>,
): TraceEvent {
  return {
    schemaVersion: 1,
    seq,
    eventId: `event-${seq}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type,
    sessionId: 'session-1',
    ...fields,
  } as TraceEvent
}
