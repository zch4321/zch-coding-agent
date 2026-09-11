import type { Static, TSchema } from '@sinclair/typebox'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ToolResultContent } from '../../shared/message'
import type { PolicySignal } from '../../shared/agent-events'
import type { ApprovedToolCall } from './approved-tool-call'
import type { SessionTempPaths } from '../session-temp/service'

export type Effect =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'process.spawn'
  | 'process.write'
  | 'terminal.read'
  | 'terminal.write'
  | 'network.request'
  | 'instruction.read'
  | 'vcs.read'
  | 'vcs.write'
  | 'workspace.metadata.write'
  | 'code.read'
  | 'external.unknown'

export type ToolExecutionMode = 'parallel' | 'serial'
export type ToolModelOutputPolicy = 'bounded' | 'paged' | 'passthrough'

export type SuccessfulToolResult = Extract<ToolResult, { status: 'ok' }>
export type ToolModelContentPart = ToolResultContent[number]

export interface ToolResultProjection {
  content: ToolModelContentPart[]
  isError: boolean
  truncated: boolean
  outputPolicy: ToolModelOutputPolicy
}

export interface ToolDefinition<Schema extends TSchema = TSchema> {
  id: string
  description: string
  inputSchema: Schema
  /** Applies pure, idempotent tool normalization before schema validation and approval. */
  normalizeArgs?(args: JsonValue): JsonValue
  /** Controls whether adjacent calls may execute concurrently; defaults to serial. */
  executionMode?: ToolExecutionMode
  /** Derives call-specific policy and scheduling only after input validation. */
  resolveTraits?(args: Static<Schema>): {
    executionMode: ToolExecutionMode
    effects: readonly Effect[]
    defaultRisk: 'low' | 'review' | 'high'
    allowRememberedApproval?: boolean
  }
  /** False prevents a remembered launch approval from authorizing later stdin writes. */
  allowRememberedApproval?: boolean
  /** Validates live ownership and supplies trusted target context before approval. */
  policyContext?(
    args: Static<Schema>,
    owner: { sessionId: SessionId; runId: RunId },
  ): PolicySignal[]
  effects: readonly Effect[]
  defaultRisk: 'low' | 'review' | 'high'
  supportsAbort: boolean
  /** Null delegates lifetime bounds to the abortable orchestration body. */
  defaultTimeoutMs: number | null
  /** Selects byte-safety or tool-owned output handling; defaults to bounded. */
  modelOutputPolicy?: ToolModelOutputPolicy
  validateArgs?(args: Static<Schema>): string | undefined
  /** Projects a successful internal result into deterministic model-visible parts. */
  projectResultForModel?(
    result: SuccessfulToolResult,
    args: Static<Schema>,
  ): ToolModelContentPart[]
  execute(
    args: Static<Schema>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>
}

export interface ToolCall {
  id: CallId
  toolId: string
  args: JsonValue
  reason: string
}

export interface ToolExecutionContext {
  sessionId: SessionId
  ownerSessionId?: SessionId
  runId: RunId
  workspace: {
    canonicalPath: string
  }
  sessionTemp?: SessionTempPaths
  maxSubagents?: number
  toolOutputLimits?: {
    maxToolOutputBytes: number
    maxToolOutputLines: number
  }
  readOnlyWorkspace?: boolean
  signal: AbortSignal
  approvedCall: ApprovedToolCall
}

export type ToolResult =
  | {
      status: 'ok'
      content: JsonValue
      truncated?: boolean
      totalBytes?: number
    }
  | {
      status: 'error'
      code: string
      message: string
      retryable: boolean
    }
  | {
      status: 'denied' | 'cancelled' | 'timeout'
      message: string
    }

export interface ToolRegistrationPort {
  registerTool(definition: ToolDefinition): void
}
