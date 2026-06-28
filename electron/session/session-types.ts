import type { WebContents } from 'electron'
import type { PermissionMode, PublicConfig } from '../../shared/config'
import type {
  AgentEvent,
  RunStatus,
  TerminalEvent,
} from '../../shared/agent-events'
import type { CallId, EventId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type { TraceLogger } from '../logging/logger'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ChangeHistoryStore } from './change-history'
import type { AutoApprover } from '../permission/auto-approver'
import type { LLMProvider, ProviderMessage } from '../providers/provider'
import type { HumanApprovalDecision } from '../permission/permission-pipeline'
import type { SkillsManager } from '../skills/manager'
import type { PromptRegistry } from '../prompts/registry'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { PromptLedgerEntry } from './prompt-harness'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'

export type AgentEventDraft = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never

export type TerminalEventDraftEnvelope = TerminalEvent extends infer Event
  ? Event extends TerminalEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never

export interface SessionManagerOptions {
  configStore: ConfigStore
  traceDirectory: string
  getWebContents: () => WebContents | undefined
  pluginBus?: PluginEventBus
  skillsManager?: SkillsManager
  changeHistory?: ChangeHistoryStore
  projectMetadata?: ProjectMetadataStore
  codeBackends?: CodeBackendManager
  promptRegistry?: PromptRegistry
  fetchImpl?: typeof fetch
  providerFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => LLMProvider
  autoApproverFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => AutoApprover
  onDiagnostic?: (message: string, error?: unknown) => void
}

export interface PendingApproval {
  callId: CallId
  expiresAt: number
  resolve: (decision: HumanApprovalDecision) => void
}

export type InterjectionStatus = 'queued' | 'injected' | 'superseded'

export interface RunInterjection {
  id: string
  clientRequestId: string
  conversationId?: string
  runId: RunId
  content: string
  createdAt: string
  status: InterjectionStatus
  injectedAfterToolBatchId?: string
}

export interface ActiveRun {
  runId: RunId
  clientRequestId: string
  controller: AbortController
  done: Promise<void>
  status: RunStatus
  toolTokensUsed: number
  pendingApproval?: PendingApproval
  pendingInterjections: RunInterjection[]
  // Tracks every clientRequestId this run has accepted (queued, injected,
  // superseded or carried over) so duplicate IPC retries are no-ops across
  // the full interjection lifecycle, not just while queued.
  processedInterjectionIds: Set<string>
  lastToolBatchId?: string
  currentTurnStartIndex?: number
}

export interface SessionState {
  sessionId: SessionId
  conversationId?: string
  workspace: string
  mode: PermissionMode
  provider: string
  logger: TraceLogger
  history: ProviderMessage[]
  promptLedger: PromptLedgerEntry[]
  nextPromptSeq: number
  lastRuntimeContextHash?: string
  lastAgentsContextHash?: string
  providerRequestOverride?: JsonValue
  forkedFromEventId?: EventId
  goal?: GoalState
  plan?: PlanState
  eventSeq: number
  closed: boolean
  activeRun?: ActiveRun
  clientRequests: Map<string, RunId>
}
