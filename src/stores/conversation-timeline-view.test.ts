import { computed, reactive, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import { blankOverlay } from './agent-runtime-helpers'
import { createConversationTimeline } from './conversation-timeline-view'

function history(count = 200): MessageRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    id: `message:${index}` as MessageId,
    sessionId: 'session:views' as SessionId,
    seq: index + 1,
    kind: 'user_input',
    visibility: 'visible',
    inHistory: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    clientRequestId: `request:${index}`,
    parts: [{ type: 'text', text: `Message ${index}` }],
    metadata: { schemaVersion: 1, submission: { type: 'message' } },
  }))
}

describe('independent timeline views', () => {
  it('does not reproject history or update messages and tools for 1000 CoT deltas', () => {
    const records = vi.fn(() => historyRecords)
    const historyRecords = history()
    const overlay = reactive({
      ...blankOverlay(),
      runId: 'run:views' as RunId,
      text: 'An unchanged reply',
      reasoning: 'Thinking',
      tools: [
        {
          callId: 'call:one' as CallId,
          runId: 'run:views' as RunId,
          tool: 'read_file',
          args: { path: 'file' },
          reason: '',
          status: 'completed' as const,
          result: { content: 'x'.repeat(8192) },
        },
      ],
    })
    const timeline = createConversationTimeline({
      records,
      overlay: () => overlay,
    })
    const initial = timeline.value
    const last = initial.at(-1)!
    const text = computed(() => last.messages.at(-1)!.text)
    const reasoning = computed(() => last.reasoningSegments.at(-1)!.text)
    expect(reasoning.value).toBe('Thinking')
    for (let index = 0; index < 1000; index++) {
      overlay.reasoning += 'x'
      expect(timeline.value).toBe(initial)
    }
    expect(records).toHaveBeenCalledTimes(1)
    expect(text.value).toBe('An unchanged reply')
    expect(reasoning.value).toBe(overlay.reasoning)
    expect(timeline.value.at(-1)?.tools).toBe(last.tools)
    expect(timeline.value.at(-1)?.messages).toBe(last.messages)
  })

  it('replaces only the changed tool and preserves history through pagination and session changes', () => {
    const records = shallowRef(history(2))
    const overlay = reactive({ ...blankOverlay(), runId: 'run:views' as RunId })
    for (const id of ['one', 'two'])
      overlay.tools.push({
        callId: `call:${id}` as CallId,
        runId: overlay.runId,
        tool: 'read_file',
        args: { path: id },
        reason: '',
        status: 'proposed',
      })
    const timeline = createConversationTimeline({
      records: () => records.value,
      overlay: () => overlay,
    })
    const initial = timeline.value
    overlay.tools[0]!.status = 'completed'
    overlay.tools[0]!.result = { content: 'done' }
    const updated = timeline.value
    expect(updated[0]).toBe(initial[0])
    expect(updated.at(-1)?.tools[0]).not.toBe(initial.at(-1)?.tools[0])
    expect(updated.at(-1)?.tools[1]).toBe(initial.at(-1)?.tools[1])
    records.value = [
      { ...history(1)[0]!, id: 'message:earlier' as MessageId, seq: 0 },
      ...records.value,
    ]
    expect(timeline.value[1]).toBe(updated[0])
    overlay.reasoning = 'new thought'
    const segment = timeline.value.at(-1)!.reasoningSegments.at(-1)!
    overlay.reasoning = ''
    expect(timeline.value.at(-1)?.reasoningSegments).toHaveLength(0)
    expect(segment.text).toBe('')
    records.value = []
    overlay.runId = 'run:other' as RunId
    overlay.tools = []
    overlay.text = 'Other session'
    expect(timeline.value).toHaveLength(1)
    expect(timeline.value[0]?.messages[0]?.text).toBe('Other session')
    expect(timeline.value[0]?.tools).toHaveLength(0)
  })
})
