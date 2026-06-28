import { handleApprovalEvent } from './approval-events'
import { handleAssistantEvent } from './assistant-events'
import { handleInterjectionEvent } from './interjection-events'
import { handleOrchestrationEvent } from './orchestration-events'
import { handleRunEvent } from './run-events'
import { handleToolEvent } from './tool-events'
import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

export { carryoverFromMessages, enqueueCarryover } from './interjection-events'
export type { PendingCarryoverInterjection } from './types'

export function handleRuntimeAgentEvent(
  event: RuntimeDomainEvent,
  context: RuntimeEventContext,
): void {
  switch (event.type) {
    case 'run.status':
    case 'llm.usage':
      handleRunEvent(event, context)
      return
    case 'assistant.text.delta':
    case 'assistant.reasoning.delta':
    case 'assistant.message.completed':
      handleAssistantEvent(event, context)
      return
    case 'tool.proposed':
    case 'tool.completed':
      handleToolEvent(event, context)
      return
    case 'orchestrator.message':
    case 'goal.updated':
    case 'plan.updated':
      handleOrchestrationEvent(event, context)
      return
    case 'interjection.updated':
    case 'interjection.carryover':
      handleInterjectionEvent(event, context)
      return
    case 'approval.requested':
      handleApprovalEvent(event, context)
      return
  }

  const exhaustive: never = event
  return exhaustive
}
