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
import type { AutoApprover } from '../permission/auto-approver'
import type { DiagnosticSink } from '../diagnostics'
import type { ModelProvider } from '../providers/provider'
import type { HumanApprovalDecision } from '../permission/permission-pipeline'
import type { SkillsManager } from '../skills/manager'
import type { PromptRegistry } from '../prompts/registry'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { McpManager } from '../mcp/mcp-manager'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'
import type {
  ActiveRunPublicSnapshot,
  ActiveRunToolSnapshot,
} from '../../shared/runtime-state'
import type { SessionCommandResult } from '../../shared/domain-state-api'
import type { FileChangeExecutionPort } from './file-change-execution'
import type { SessionTraceController } from './session-trace-controller'
import type { SubagentExecutionPort } from '../subagent/contracts'
import type { LlmUsageRecord } from '../../shared/usage'

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

export interface SessionManagerOptions {
  configStore: ConfigStore
  traceDirectory: string
  eventSink: RuntimeEventSink
  pluginBus?: PluginEventBus
  skillsManager?: SkillsManager
  fileChangeExecution?: FileChangeExecutionPort
  mcpManager?: McpManager
  subagentExecution?: SubagentExecutionPort
  promptRegistry?: PromptRegistry
  fetchImpl?: typeof fetch
  providerFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => ModelProvider
  autoApproverFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => AutoApprover
  traceLoggerFactory?: (
    sessionId: SessionId,
  ) => TraceLogger | Promise<TraceLogger>
  executionState?: SessionExecutionStatePort
  onDiagnostic?: DiagnosticSink
}

export interface SessionExecutionCommit {
  reason:
    | 'run_input'
    | 'command_input'
    | 'interjection'
    | 'assistant_turn'
    | 'tool_batch'
    | 'compact'
    | 'metadata'
  deactivateThroughSeq?: number
  invalidate?: boolean
}

export interface SessionExecutionStatePort {
  commit(
    session: SessionState,
    input: SessionExecutionCommit,
  ): Promise<SessionCommandResult | undefined>
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
  failure?: { code: string; message: string }
  toolTokensUsed: number
  usageRecords: LlmUsageRecord[]
  fileChangeHistoryBytes: number
  pendingApproval?: PendingApproval
  pendingInterjections: RunInterjection[]
  acceptingInterjections: boolean
  // Tracks every clientRequestId this run has accepted (queued, injected,
  // superseded or carried over) so duplicate IPC retries are no-ops across
  // the full interjection lifecycle, not just while queued.
  processedInterjectionIds: Set<string>
  lastToolBatchId?: string
  rootUserMessageId?: MessageId
  harnessMessageIds: MessageId[]
  autoCompactEligible: boolean
  requestCommitted: boolean
  publicSnapshot: ActiveRunPublicSnapshot
  publicTools: Map<CallId, ActiveRunToolSnapshot>
  routes?: {
    main: ResolvedModelRoute
    compression: ResolvedModelRoute
    approval?: ResolvedModelRoute
  }
  subagentsEnabled: boolean
  allowedToolIds?: Set<string>
  directUserInput: boolean
}

// P4 target terminology. The legacy facade and durable composition share this
// exact execution object rather than maintaining two provider/tool loops.
export type ActiveRunExecution = ActiveRun

export interface SessionState {
  sessionId: SessionId
  workspace: string
  mode: PermissionMode
  provider: string
  modelSelection: ModelSelection
  modelSelectionPinned: boolean
  trace: SessionTraceController
  logger: TraceLogger
  history: MessageRecord[]
  nextMessageSeq: number
  goal?: GoalState
  plan?: PlanState
  eventSeq: number
  closed: boolean
  visibility: 'public' | 'internal'
  readOnlyWorkspace: boolean
  allowedToolIds?: Set<string>
  gitToolsEnabled: boolean
  activeRun?: ActiveRun
  mutationInProgress?: boolean
  clientRequests: Map<string, RunId>
  mcpDisclosures: Map<string, { revision: string; toolNames: Set<string> }>
}
