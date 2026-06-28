import type { RuntimeDomainEvent, RuntimeEventContext } from './types'

type ApprovalEvent = Extract<RuntimeDomainEvent, { type: 'approval.requested' }>

export function handleApprovalEvent(
  event: ApprovalEvent,
  context: RuntimeEventContext,
): void {
  const { runtime, timeline } = context

  if (event.diff) timeline.latestReviewedApproval = undefined
  runtime.pendingApproval = {
    runId: event.runId,
    callId: event.callId,
    kind: event.kind,
    tool: event.tool,
    args: event.args,
    reason: event.reason,
    signals: event.policySignals,
    diff: event.diff,
    diffHash: event.diffHash,
    rememberable: event.rememberable,
    rememberArgConstraints: event.rememberArgConstraints,
    expiresAt: event.expiresAt,
    status: 'requested',
    order: timeline.nextTimelineOrder(),
  }
}
