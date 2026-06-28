import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

type AssistantEvent = Extract<
  RuntimeDomainEvent,
  | { type: 'assistant.text.delta' }
  | { type: 'assistant.reasoning.delta' }
  | { type: 'assistant.message.completed' }
>

export function handleAssistantEvent(
  event: AssistantEvent,
  context: RuntimeEventContext,
): void {
  const { timeline, schedulePersist } = context

  if (event.type === 'assistant.text.delta') {
    timeline.assistantMessage(event.runId).text += event.delta
    schedulePersist()
    return
  }

  if (event.type === 'assistant.reasoning.delta') {
    timeline.assistantMessage(event.runId).reasoning += event.delta
    schedulePersist()
    return
  }

  const message = timeline.assistantMessage(event.runId)
  message.text = event.text
  if (event.reasoning !== undefined) {
    message.reasoning = event.reasoning
  }
  schedulePersist()
}
