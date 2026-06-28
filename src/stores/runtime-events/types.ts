import type { AgentEvent, RunStatus } from '../../../shared/agent-events'
import type { RunId } from '../../../shared/ids'
import type { useAgentChangesStore } from '../agent-changes'
import type { PendingApproval } from '../agent-types'
import type { useAgentTimelineStore } from '../agent-timeline'

export interface PendingCarryoverInterjection {
  interjectionId: string
  content: string
}

export type RuntimeDomainEvent = Exclude<AgentEvent, { type: 'session.closed' }>

export interface RuntimeEventState {
  activeRunId: RunId | undefined
  runStatus: RunStatus | 'idle' | string
  pendingApproval: PendingApproval | undefined
  pendingCarryover: PendingCarryoverInterjection[]
  error: string
}

export interface RuntimeEventContext {
  runtime: RuntimeEventState
  timeline: ReturnType<typeof useAgentTimelineStore>
  changes: ReturnType<typeof useAgentChangesStore>
  schedulePersist(touchUpdatedAt?: boolean): void
  flushCarryoverInterjections(): void | Promise<void>
}
