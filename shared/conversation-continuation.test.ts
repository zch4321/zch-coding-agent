import { describe, expect, it } from 'vitest'
import type { MessageId, SessionId } from './ids'
import type { MessageRecord } from './message'
import { resolveManualContinuationTarget } from './conversation-continuation'

const sessionId = 'session:continuation' as SessionId

function record(
  kind: MessageRecord['kind'],
  id: string,
  seq: number,
  extra: Record<string, unknown> = {},
): MessageRecord {
  return {
    schemaVersion: 1,
    id: id as MessageId,
    sessionId,
    seq,
    visibility: 'visible',
    inHistory: true,
    createdAt: '2026-08-27T00:00:00.000Z',
    kind,
    parts: [{ type: 'text', text: id }],
    ...extra,
  } as unknown as MessageRecord
}

describe('resolveManualContinuationTarget', () => {
  it('resolves user, tool, interjection, and orchestrator continuation roots', () => {
    const root = 'message:user' as MessageId
    for (const kind of [
      'tool_result',
      'interjection',
      'orchestrator',
    ] as const) {
      expect(
        resolveManualContinuationTarget([
          record('user_input', root, 1),
          record(kind, `message:${kind}`, 2, { turnId: root }),
        ]),
      ).toEqual({
        rootUserMessageId: root,
        anchorMessageId: `message:${kind}`,
      })
    }
  })

  it('ignores trailing passive prompt layers and inactive records', () => {
    const root = 'message:user' as MessageId
    expect(
      resolveManualContinuationTarget([
        record('user_input', root, 1),
        record('assistant_turn', 'message:inactive', 2, {
          inHistory: false,
        }),
        record('runtime_context', 'message:runtime', 3),
      ]),
    ).toEqual({
      rootUserMessageId: root,
      anchorMessageId: root,
    })
  })

  it('only treats automatic compact summaries with a turn as continuable', () => {
    const root = 'message:user' as MessageId
    expect(
      resolveManualContinuationTarget([
        record('compact_summary', 'message:compact', 1, { turnId: root }),
      ]),
    ).toEqual({
      rootUserMessageId: root,
      anchorMessageId: 'message:compact',
    })
    expect(
      resolveManualContinuationTarget([
        record('compact_summary', 'message:manual-compact', 1),
      ]),
    ).toBeUndefined()
  })

  it('rejects completed turns, control commands, and imported transcripts', () => {
    const user = record('user_input', 'message:user', 1)
    expect(
      resolveManualContinuationTarget([
        user,
        record('assistant_turn', 'message:assistant', 2),
      ]),
    ).toBeUndefined()
    expect(
      resolveManualContinuationTarget([
        record('user_input', 'message:compact-command', 1, {
          clientRequestId: 'request:compact',
          metadata: {
            schemaVersion: 1,
            submission: { type: 'control_command', command: 'compact' },
          },
        }),
      ]),
    ).toBeUndefined()
    expect(
      resolveManualContinuationTarget([
        record('conversation_transcript', 'message:transcript', 1),
      ]),
    ).toBeUndefined()
  })
})
