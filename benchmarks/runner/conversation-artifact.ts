import { createHash } from 'node:crypto'
import type { TraceEvent } from '../../electron/logging/events'
import {
  normalizeSessionTranscript,
  sessionTranscriptToMarkdown,
} from '../../electron/logging/session-transcript'
import { conversationToMarkdown } from '../../shared/conversation-markdown'
import type { ChatMessage, ConversationRecord } from '../../shared/workbench'

export function benchmarkConversationMarkdown(input: {
  trace: readonly TraceEvent[]
  caseId: string
}): string {
  const session = input.trace.find(
    (event): event is Extract<TraceEvent, { type: 'session.start' }> =>
      event.type === 'session.start',
  )
  if (!session) throw new Error('Benchmark trace has no session.start event')

  const messages = input.trace.flatMap((event): ChatMessage[] => {
    if (event.type === 'user.message') {
      return [
        {
          id: event.eventId,
          role: 'user',
          runId: event.runId,
          text: event.text,
          reasoning: '',
          order: event.seq,
        },
      ]
    }
    if (event.type === 'agent.message') {
      return [
        {
          id: event.eventId,
          role: 'assistant',
          runId: event.runId,
          text: event.text,
          reasoning: event.reasoning ?? '',
          order: event.seq,
        },
      ]
    }
    if (event.type === 'orchestrator.message') {
      return [
        {
          id: event.eventId,
          role: 'orchestrator',
          runId: event.runId,
          text: event.text,
          reasoning: '',
          order: event.seq,
        },
      ]
    }
    return []
  })
  if (messages.length === 0) {
    throw new Error('Benchmark trace has no exportable conversation messages')
  }

  const updatedAt = input.trace.at(-1)?.ts ?? session.ts
  const conversation: ConversationRecord = {
    id: session.sessionId,
    projectPath: session.workspace,
    title: `Benchmark: ${input.caseId}`,
    model: session.model,
    mode: 'yolo',
    messages,
    tools: [],
    usage: [],
    createdAt: session.ts,
    updatedAt,
  }
  return conversationToMarkdown(conversation)
}

export function benchmarkSessionTranscriptMarkdown(input: {
  trace: readonly TraceEvent[]
}): string {
  const session = input.trace.find(
    (event): event is Extract<TraceEvent, { type: 'session.start' }> =>
      event.type === 'session.start',
  )
  if (!session) throw new Error('Benchmark trace has no session.start event')
  const revision = createHash('sha256')
    .update(input.trace.map((event) => JSON.stringify(event)).join('\n'))
    .digest('hex')
  return sessionTranscriptToMarkdown(
    normalizeSessionTranscript(input.trace, {
      traceId: session.sessionId,
      revision,
      generatedAt: input.trace.at(-1)?.ts ?? session.ts,
      active: !input.trace.some((event) => event.type === 'session.end'),
    }),
  )
}
