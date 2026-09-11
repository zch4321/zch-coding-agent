import type { CallId, MessageId, ProjectId, RunId } from '../../shared/ids'
import type { ModelProfile } from '../../shared/ipc/configuration'
import type { LlmUsageRecord } from '../../shared/usage'
import type { ContextAttachmentChip } from '../../shared/context'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type {
  ProviderRetryState,
  ToolApprovalSummary,
} from '../../shared/agent-events'
import type { TodoState } from '../../shared/todo'

export type RunActivity =
  | 'requesting_model'
  | 'retrying_model'
  | 'reasoning'
  | 'output'
  | 'calling_tool'
  | 'executing_tool'
  | 'awaiting_approval'
  | 'cancelling'

// Keep the unused raw payload opaque to Vue's recursive reactive type unwrapping.
export type UiLlmUsageRecord = Omit<LlmUsageRecord, 'raw'> & { raw: unknown }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'orchestrator' | 'interjection'
  durableKind:
    | 'user_input'
    | 'assistant_turn'
    | 'orchestrator'
    | 'interjection'
    | 'stream'
  runId?: RunId
  text: string
  order?: number
  attachments?: ContextAttachmentChip[]
  interjectionId?: string
  interjectionStatus?: 'queued' | 'injected' | 'superseded' | 'carryover'
  retryable?: boolean
  editable?: boolean
  live?: boolean
}

export interface ReasoningSegment {
  id: string
  runId?: RunId
  text: string
  order: number
  live?: boolean
}

export interface ToolActivity {
  callId: CallId
  runId: RunId
  tool: string
  args: unknown
  reason: string
  status: 'proposed' | 'completed'
  result?: unknown
  approval?: ToolApprovalSummary
  order?: number
  live?: boolean
}

export interface ConversationTurn {
  id: string
  sourceTurnId?: MessageId
  order: number
  userMessage?: ChatMessage
  todo?: TodoState
  tools: ToolActivity[]
  reasoningSegments: ReasoningSegment[]
  messages: ChatMessage[]
  runActivity?: RunActivity
  providerRetry?: ProviderRetryState
  finalAssistantMessageId?: string
}

export interface UsageActivity {
  runId: RunId
  callId: CallId
  usage: UiLlmUsageRecord
  order?: number
}

export interface ReviewedApproval {
  runId: RunId
  callId: CallId
  tool: string
  reason: string
  decision: 'allowed' | 'denied' | 'stale'
}

export interface OrchestratorEntry {
  id: string
  kind: string
  text: string
  createdAt: string
  runId?: RunId
  promptId?: string
  promptHash?: string
  order?: number
}

export interface ProjectView {
  id: ProjectId
  path: string
  name: string
  addedAt: string
}

export interface SessionView {
  id: string
  projectId: string
  projectPath: string
  title: string
  model: string
  mode: import('../../shared/config').PermissionMode
  goal?: GoalState
  plan?: PlanState
  orchestratorEntries?: OrchestratorEntry[]
  parentId?: string
  forkedAt?: string
  createdAt: string
  updatedAt: string
  revision: number
  archived: boolean
}

export type { ContextAttachmentChip, GoalState, PlanState }

export interface PendingApproval {
  runId: RunId
  callId: CallId
  kind: 'tool' | 'context'
  tool: string
  args: unknown
  reason: string
  signals: Array<{ code: string; severity: string; detail: string }>
  rememberable: boolean
  rememberArgConstraints?: unknown
  expiresAt: string
  status: 'requested' | 'submitting'
  order: number
}

export interface UiRememberedRule {
  id: string
  effect: 'allow' | 'review'
  toolId: string
  workspaceScope: string
  argConstraints: string
  expiresAt?: string
  createdFromCallId: string
}

export type UiModelProfile = ModelProfile
