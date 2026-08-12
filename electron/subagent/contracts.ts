import type { LlmUsageRecord } from '../../shared/usage'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'
import type { RunStatus } from '../../shared/agent-events'

export interface SubagentSpec {
  name: string
  task: string
  sharedContext?: string
}

export interface SubagentParentContext {
  sessionId: SessionId
  runId: RunId
  callId: CallId
  workspace: string
  signal: AbortSignal
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
}

/** Runs one backend-private Subagent against a frozen parent Run context. */
export interface SubagentExecutionPort {
  runOne(
    spec: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<SubagentRunResult>
}

/** Runs both standalone and pre-persisted model-pool Subagent executions. */
export interface PreparedSubagentExecutionPort extends SubagentExecutionPort {
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
