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
import type { AutoApprover } from './auto-approver'
import type { LLMProvider, ProviderMessage } from './provider'
import type { HumanApprovalDecision } from './permission-pipeline'
import type { SkillsManager } from '../skills/manager'

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

export interface ActiveRun {
  runId: RunId
  clientRequestId: string
  controller: AbortController
  done: Promise<void>
  status: RunStatus
  toolTokensUsed: number
  pendingApproval?: PendingApproval
}

export interface SessionState {
  sessionId: SessionId
  conversationId?: string
  workspace: string
  mode: PermissionMode
  provider: 'deepseek'
  logger: TraceLogger
  history: ProviderMessage[]
  systemPromptOverride?: string
  providerRequestOverride?: JsonValue
  forkedFromEventId?: EventId
  eventSeq: number
  closed: boolean
  activeRun?: ActiveRun
  clientRequests: Map<string, RunId>
}
