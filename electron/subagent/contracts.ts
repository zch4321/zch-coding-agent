import type { LlmUsageRecord } from '../../shared/usage'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'
import type { RunStatus } from '../../shared/agent-events'
import type { AgentToolAccess } from '../../shared/agent-execution'
import type { PermissionMode } from '../../shared/config'
import type { SessionTempPaths } from '../session-temp/service'

export interface BackgroundTaskHandle {
  target: { type: 'subagent' | 'swarm'; id: string }
  status:
    | 'queued'
    | 'preparing'
    | 'running'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'interrupted'
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
}

export interface BackgroundArtifactStatus {
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
}

export interface SubagentSpec {
  name: string
  task: string
  toolAccess: AgentToolAccess
  sharedContext?: string
}

export interface SubagentParentContext {
  sessionId: SessionId
  runId: RunId
  callId: CallId
  workspace: string
  signal: AbortSignal
  ownerSessionId?: SessionId
  sessionTemp?: SessionTempPaths
  maxSubagents?: number
}

export interface InternalSessionOwnership {
  executionId: AgentExecutionId
  parentSessionId: SessionId
  createdAt: string
}

export interface FrozenSubagentRoutes {
  main: ResolvedModelRoute
  compression: ResolvedModelRoute
}

export interface FrozenSubagentToolContext {
  permissionMode: PermissionMode
  allowedToolIds: ReadonlySet<string>
  gitToolsEnabled: boolean
}

export interface InternalSubagentRunOutcome {
  status: RunStatus
  response?: string
  finishReason?: string
  usage: LlmUsageRecord[]
  error?: { code: string; message: string }
}

/** Carries a stable code through ToolResult normalization without leaking internals. */
export class SubagentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SubagentRuntimeError'
  }
}

export interface SubagentUsageSummary {
  records: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface SubagentRunResult {
  results: Record<string, string>
  meta: {
    durationMs: number
    providerId: string
    model: string
    usage: SubagentUsageSummary
    truncated: boolean
  }
}

export interface PreparedSubagentExecution {
  executionId: AgentExecutionId
  parentExecutionId: AgentExecutionId
  childOrdinal: number
  routes: FrozenSubagentRoutes
  toolContext?: FrozenSubagentToolContext
  cancellationSignal?: AbortSignal
}

/** Runs one backend-private Subagent against a frozen parent Run context. */
export interface SubagentExecutionPort {
  startOne?(
    spec: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<BackgroundTaskHandle>
  runOne(
    spec: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<SubagentRunResult>
}

/** Runs both standalone and pre-persisted model-pool Subagent executions. */
export interface PreparedSubagentExecutionPort extends SubagentExecutionPort {
  cancel?(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): boolean | Promise<boolean>
  artifactStatus?(
    executionId: AgentExecutionId,
  ): BackgroundArtifactStatus | undefined
  runPrepared(
    spec: SubagentSpec,
    parent: SubagentParentContext,
    prepared: PreparedSubagentExecution,
  ): Promise<SubagentRunResult>
}

/** Aggregates normalized usage without retaining Provider-specific raw payloads. */
export function summarizeSubagentUsage(
  records: readonly LlmUsageRecord[],
): SubagentUsageSummary {
  const sum = (field: keyof LlmUsageRecord): number =>
    records.reduce((total, record) => {
      const value = record[field]
      return total + (typeof value === 'number' ? value : 0)
    }, 0)

  return {
    records: records.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    cacheHitTokens: sum('cacheHitTokens'),
    cacheMissTokens: sum('cacheMissTokens'),
  }
}
