import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

type RunEvent = Extract<
  RuntimeDomainEvent,
  { type: 'run.status' } | { type: 'llm.usage' }
>

const terminalRunStatuses = new Set(['completed', 'cancelled', 'failed'])

export function handleRunEvent(
  event: RunEvent,
  context: RuntimeEventContext,
): void {
  const { runtime, timeline, schedulePersist, flushCarryoverInterjections } =
    context

  if (event.type === 'llm.usage') {
    timeline.usage.push({
      runId: event.runId,
      callId: event.callId,
      usage: event.usage,
      order: timeline.nextTimelineOrder(),
    })
    schedulePersist()
    return
  }

  runtime.runStatus = event.status
  runtime.activeRunId = terminalRunStatuses.has(event.status)
    ? undefined
    : event.runId
  if (event.error) runtime.error = event.error.message
  if (!runtime.activeRunId) {
    schedulePersist()
    void flushCarryoverInterjections()
  }
}
