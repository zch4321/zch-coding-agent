import { requestId } from '../workbench-persistence'
import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

type OrchestrationEvent = Extract<
  RuntimeDomainEvent,
  | { type: 'orchestrator.message' }
  | { type: 'goal.updated' }
  | { type: 'plan.updated' }
>

export function handleOrchestrationEvent(
  event: OrchestrationEvent,
  context: RuntimeEventContext,
): void {
  const { timeline, schedulePersist } = context

  if (event.type === 'orchestrator.message') {
    timeline.messages.push({
      id: requestId(),
      role: 'orchestrator',
      runId: event.runId,
      text: event.text,
      reasoning: '',
      order: timeline.nextTimelineOrder(),
    })
    schedulePersist()
    return
  }

  if (event.type === 'goal.updated') {
    timeline.goal = event.goal ? structuredClone(event.goal) : undefined
    schedulePersist()
    return
  }

  timeline.plan = event.plan ? structuredClone(event.plan) : undefined
  schedulePersist()
}
