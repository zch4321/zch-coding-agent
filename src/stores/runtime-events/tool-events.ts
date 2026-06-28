import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

type ToolEvent = Extract<
  RuntimeDomainEvent,
  { type: 'tool.proposed' } | { type: 'tool.completed' }
>

const workspaceMutatingTools = new Set([
  'create_file',
  'apply_patch',
  'delete_file',
])

export function handleToolEvent(
  event: ToolEvent,
  context: RuntimeEventContext,
): void {
  const { runtime, timeline, changes } = context

  if (event.type === 'tool.proposed') {
    timeline.tools.unshift({
      callId: event.callId,
      runId: event.runId,
      tool: event.tool,
      args: event.args,
      reason: event.reason,
      status: 'proposed',
      order: timeline.nextTimelineOrder(),
    })
    return
  }

  const tool = timeline.tools.find((item) => item.callId === event.callId)
  if (tool) {
    tool.status = 'completed'
    tool.result = event.result
    tool.approval = event.approval
    if (workspaceMutatingTools.has(tool.tool)) {
      void changes.loadConversationChanges()
    }
  }

  if (
    runtime.pendingApproval?.runId === event.runId &&
    runtime.pendingApproval.callId === event.callId
  ) {
    runtime.pendingApproval = undefined
  }
}
