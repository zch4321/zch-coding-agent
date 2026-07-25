import type { CallId, RunId } from '../../shared/ids'
import type { ContextAttachmentChip } from '../../shared/context'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ToolApprovalSummary } from '../../shared/agent-events'

export interface UiLlmUsageRecord {
  scope: 'main' | 'approval' | 'title' | 'compression'
  providerId: string
  providerLabel: string
  model: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  contextWindowTokens: number
  contextWindowSource: 'override' | 'builtin' | 'default' | 'provider'
  raw: unknown
}

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
  reasoning: string
  order?: number
  attachments?: ContextAttachmentChip[]
  interjectionId?: string
  interjectionStatus?: 'queued' | 'injected' | 'superseded' | 'carryover'
  retryable?: boolean
  editable?: boolean
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
  diff: string
  diffHash?: string
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
  id: string
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
  diff?: string
  diffHash?: string
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

export interface UiModelProfile {
  id: string
  ownedBy?: string
  availability: 'provider' | 'custom'
  capabilitySource: 'override' | 'builtin' | 'default'
  contextWindowTokens: number
  maxOutputTokens?: number
}
