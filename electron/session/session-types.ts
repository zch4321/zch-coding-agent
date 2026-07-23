import type { PermissionMode, PublicConfig } from '../../shared/config'
import type {
  AgentEvent,
  RunStatus,
  TerminalEvent,
} from '../../shared/agent-events'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ModelSelection } from '../../shared/model-route'
import type { ConfigStore } from '../config/store'
import type { TraceLogger } from '../logging/logger'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ChangeHistoryStore } from './change-history'
import type { AutoApprover } from '../permission/auto-approver'
import type { LLMProvider } from '../providers/provider'
import type { HumanApprovalDecision } from '../permission/permission-pipeline'
import type { SkillsManager } from '../skills/manager'
import type { PromptRegistry } from '../prompts/registry'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'
import type { McpManager } from '../mcp/mcp-manager'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'

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

export interface HarnessRunMessage {
  kind: string
  text: string
  source: string
  promptId?: string
  promptHash?: string
}

export interface RunHarnessContext {
  kind: 'benchmark_case'
  text: string
  source: string
}

export interface SessionManagerOptions {
  configStore: ConfigStore
  traceDirectory: string
  eventSink: RuntimeEventSink
  pluginBus?: PluginEventBus
  skillsManager?: SkillsManager
  changeHistory?: ChangeHistoryStore
  projectMetadata?: ProjectMetadataStore
  codeBackends?: CodeBackendManager
  mcpManager?: McpManager
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
  releaseRunSlot: () => void
  releaseWriter: () => void
  pendingSideEffects: Set<Promise<void>>
  writerReleasePending: boolean
  status: RunStatus
  toolTokensUsed: number
  pendingApproval?: PendingApproval
  pendingInterjections: RunInterjection[]
  // Tracks every clientRequestId this run has accepted (queued, injected,
  // superseded or carried over) so duplicate IPC retries are no-ops across
  // the full interjection lifecycle, not just while queued.
  processedInterjectionIds: Set<string>
  lastToolBatchId?: string
  rootUserMessageId?: MessageId
  harnessMessageIds: MessageId[]
  autoCompactEligible: boolean
  routes?: {
    main: ResolvedModelRoute
    compression: ResolvedModelRoute
    approval: ResolvedModelRoute
  }
}

export interface SessionState {
  sessionId: SessionId
  conversationId?: string
  workspace: string
  mode: PermissionMode
  provider: string
  modelSelection: ModelSelection
  logger: TraceLogger
  history: MessageRecord[]
  nextMessageSeq: number
  goal?: GoalState
  plan?: PlanState
  eventSeq: number
  closed: boolean
  activeRun?: ActiveRun
  clientRequests: Map<string, RunId>
  mcpDisclosures: Map<string, { revision: string; toolNames: Set<string> }>
}
