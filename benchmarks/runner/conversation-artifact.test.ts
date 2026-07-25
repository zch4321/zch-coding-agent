import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../electron/logging/events'
import { benchmarkSessionTranscriptMarkdown } from './conversation-artifact'

describe('benchmark conversation artifact', () => {
  it('exports the restricted trace transcript', () => {
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

    const transcript = benchmarkSessionTranscriptMarkdown({ trace })
    expect(transcript).toContain('format: "zch-session-transcript"')
    expect(transcript).toContain('run_command')
    expect(transcript).toContain('Checked the public behavior.')
    expect(transcript).toContain('not been scanned or redacted')
  })
})

function event(
  type: TraceEvent['type'],
  seq: number,
  fields: Record<string, unknown>,
): TraceEvent {
  return {
    schemaVersion: 2,
    seq,
    eventId: `event-${seq}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type,
    sessionId: 'session-1',
    ...fields,
  } as TraceEvent
}
