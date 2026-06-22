import type { CallId, RunId } from '../../shared/ids'

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
  role: 'user' | 'assistant' | 'orchestrator'
  runId?: RunId
  text: string
  reasoning: string
  order?: number
}

export interface ToolActivity {
  callId: CallId
  runId: RunId
  tool: string
  args: unknown
  reason: string
  status: 'proposed' | 'completed'
  result?: unknown
  order?: number
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

export interface ProjectRecord {
  path: string
  name: string
  addedAt: string
}

export interface ConversationRecord {
  id: string
  projectPath: string
  title: string
  model: string
  mode: import('../../shared/config').PermissionMode
  messages: ChatMessage[]
  tools?: ToolActivity[]
  usage?: UsageActivity[]
  orchestratorEntries?: OrchestratorEntry[]
  latestReviewedApproval?: ReviewedApproval
  createdAt: string
  updatedAt: string
  transient?: boolean
}

export interface PersistedWorkbench {
  projects: ProjectRecord[]
  conversations: ConversationRecord[]
  activeConversationId?: string
}

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
