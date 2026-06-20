import { describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../shared/agent-events'
import type { SessionId, TerminalId } from '../shared/ids'
import { TerminalSequenceTracker } from './terminal-sequence'

const sessionId = 'session:sequence' as SessionId
const terminalId = 'terminal:sequence' as TerminalId

function output(seq: number): TerminalEvent {
  return {
    schemaVersion: 1,
    seq,
    ts: '2026-06-19T00:00:00.000Z',
    type: 'terminal.output',
    sessionId,
    terminalId,
    chunk: String(seq),
  }
}

describe('TerminalSequenceTracker', () => {
  it('recovers once for a gap and replays only events newer than the snapshot', () => {
    const tracker = new TerminalSequenceTracker()

    expect(tracker.observe(output(1))).toBe('apply')
    expect(tracker.observe(output(3))).toBe('recover')
    expect(tracker.observe(output(4))).toBe('queue')
    expect(tracker.observe(output(4))).toBe('queue')

    const replay = tracker.completeRecovery(terminalId, 3)
    expect(replay.map((event) => event.seq)).toEqual([4, 4])
    expect(tracker.observe(replay[0]!)).toBe('apply')
    expect(tracker.observe(replay[1]!)).toBe('ignore')
    expect(tracker.observe(output(5))).toBe('apply')
  })

  it('ignores already rendered chunks', () => {
    const tracker = new TerminalSequenceTracker()
    expect(tracker.observe(output(1))).toBe('apply')
    expect(tracker.observe(output(1))).toBe('ignore')
  })
})
