import { describe, expect, it } from 'vitest'
import type { CallId, MessageId, SessionId } from '../../shared/ids'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendConversationTranscript,
  appendPromptMessage,
  appendToolResult,
  appendUserInput,
  deactivateActiveHistory,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { cloneForkMessage, rebuildActiveBranch } from './session-branch'

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'high',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}

function historyState(): CanonicalHistoryState {
  return {
    sessionId: 'session:branch-source' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
}

function appendSystem(state: CanonicalHistoryState, content: string): void {
  appendPromptMessage(state, {
    kind: 'system_instruction',
    content,
    source: 'test:system',
    trusted: true,
    editable: false,
  })
}

function appendToolBatch(
  state: CanonicalHistoryState,
  callId: CallId,
  path: string,
): void {
  appendAssistantTurn(state, {
    text: '',
    route,
    toolCalls: [{ id: callId, toolId: 'read_file', args: { path } }],
  })
  appendToolResult(state, {
    callId,
    content: [{ type: 'json', value: { path } }],
    isError: false,
    name: 'read_file',
    status: 'completed',
    truncated: false,
  })
}

function transitionedHistory(): CanonicalHistoryState {
  const state = historyState()
  const reusedCallId = 'call:reused-across-epochs' as CallId
  appendSystem(state, 'old system')
  appendUserInput(state, {
    content: 'read the old file',
    clientRequestId: 'request:old-epoch',
  })
  appendToolBatch(state, reusedCallId, 'old.txt')
  deactivateActiveHistory(state)

  appendSystem(state, 'fresh system')
  appendConversationTranscript(state, {
    content:
      '<conversation_transcript>portable old history</conversation_transcript>',
    route,
    sourceThroughSeq: 4,
    sourceHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
  })
  appendUserInput(state, {
    content: 'read the new file',
    clientRequestId: 'request:new-epoch',
  })
  appendToolBatch(state, reusedCallId, 'new.txt')
  return state
}

describe('session branch history epochs', () => {
  it('keeps the replaced epoch inactive when rebuilding after a transcript', () => {
    const state = transitionedHistory()
    for (const record of state.history) record.inHistory = false

    rebuildActiveBranch(state.history, 9)

    expect(
      state.history
        .filter((record) => record.inHistory)
        .map((record) => record.seq),
    ).toEqual([5, 6, 7, 8, 9])
    expect(() =>
      new MessageHistoryCompiler().compile(state.history),
    ).not.toThrow()
  })

  it('reactivates the original epoch when rewinding before the transcript', () => {
    const state = transitionedHistory()

    rebuildActiveBranch(state.history, 4)

    expect(
      state.history
        .filter((record) => record.inHistory)
        .map((record) => record.seq),
    ).toEqual([1, 2, 3, 4])
    expect(() =>
      new MessageHistoryCompiler().compile(state.history),
    ).not.toThrow()
  })

  it('remaps a transcript boundary across omitted fork sequence gaps', () => {
    const state = transitionedHistory()
    const transcript = state.history.find(
      (record) => record.kind === 'conversation_transcript',
    )
    if (!transcript) throw new Error('Transcript fixture is missing')
    const targetId = 'message:fork:transcript' as MessageId
    const clone = cloneForkMessage(
      transcript,
      'session:branch-target' as SessionId,
      new Map([[transcript.id, targetId]]),
      new Map([
        [1, 1],
        [4, 2],
        [5, 3],
        [6, 4],
      ]),
      4,
    )

    expect(clone).toMatchObject({
      id: targetId,
      seq: 4,
      inHistory: false,
      metadata: {
        transcript: { sourceThroughSeq: 2 },
      },
    })
  })
})
