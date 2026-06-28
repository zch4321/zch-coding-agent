import type { ChatMessage } from '../agent-types'
import { requestId } from '../workbench-persistence'
import type {
  PendingCarryoverInterjection,
  RuntimeDomainEvent,
  RuntimeEventContext,
} from './types'

type InterjectionEvent = Extract<
  RuntimeDomainEvent,
  { type: 'interjection.updated' } | { type: 'interjection.carryover' }
>

export function enqueueCarryover(
  queue: PendingCarryoverInterjection[],
  item: PendingCarryoverInterjection,
): void {
  if (!queue.some((entry) => entry.interjectionId === item.interjectionId)) {
    queue.push(item)
  }
}

export function carryoverFromMessages(
  messages: ChatMessage[],
): PendingCarryoverInterjection[] {
  return messages.flatMap((message) =>
    message.role === 'interjection' &&
    message.interjectionStatus === 'carryover' &&
    message.interjectionId
      ? [{ interjectionId: message.interjectionId, content: message.text }]
      : [],
  )
}

export function handleInterjectionEvent(
  event: InterjectionEvent,
  context: RuntimeEventContext,
): void {
  const { runtime, schedulePersist, flushCarryoverInterjections } = context

  if (event.type === 'interjection.updated') {
    upsertInterjectionMessage(context, event, event.status, event.content)
    schedulePersist()
    return
  }

  upsertInterjectionMessage(context, event, 'carryover', event.content)
  enqueueCarryover(runtime.pendingCarryover, {
    interjectionId: event.interjectionId,
    content: event.content,
  })
  schedulePersist()
  if (!runtime.activeRunId) void flushCarryoverInterjections()
}

function upsertInterjectionMessage(
  context: RuntimeEventContext,
  event: InterjectionEvent,
  status: ChatMessage['interjectionStatus'],
  content: string,
): void {
  const { timeline } = context
  const existing = timeline.messages.find(
    (item) =>
      item.role === 'interjection' &&
      item.interjectionId === event.interjectionId,
  )

  if (existing) {
    existing.interjectionStatus = status
    existing.text = content
    return
  }

  timeline.messages.push({
    id: requestId(),
    role: 'interjection',
    runId: event.runId,
    text: content,
    reasoning: '',
    interjectionId: event.interjectionId,
    interjectionStatus: status,
    order: timeline.nextTimelineOrder(),
  })
}
