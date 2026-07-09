import type { AgentEvent, RunStatus } from '../../../shared/agent-events'
import type { RunId } from '../../../shared/ids'
import type {
  ChatMessage,
  GoalState,
  PendingApproval,
  PlanState,
  ReviewedApproval,
  ToolActivity,
  UsageActivity,
} from '../agent-types'

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

export interface RuntimeEventTimeline {
  messages: ChatMessage[]
  tools: ToolActivity[]
  usage: UsageActivity[]
  goal: GoalState | undefined
  plan: PlanState | undefined
  latestReviewedApproval: ReviewedApproval | undefined
  assistantMessage(runId: RunId): ChatMessage
  nextTimelineOrder(): number
}

export interface RuntimeEventContext {
  runtime: RuntimeEventState
  timeline: RuntimeEventTimeline
  loadConversationChanges(): void | Promise<void>
  schedulePersist(touchUpdatedAt?: boolean): void
  flushCarryoverInterjections(): void | Promise<void>
}
