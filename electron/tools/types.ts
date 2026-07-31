import type { Static, TSchema } from '@sinclair/typebox'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ToolResultContent } from '../../shared/message'
import type { ApprovedToolCall } from './approved-tool-call'

export type Effect =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'process.spawn'
  | 'terminal.read'
  | 'terminal.write'
  | 'network.request'
  | 'instruction.read'
  | 'vcs.read'
  | 'vcs.write'
  | 'workspace.metadata.write'
  | 'code.read'
  | 'external.unknown'

export type ToolBatchPolicy = 'normal' | 'must_run_last' | 'exclusive'

export type SuccessfulToolResult = Extract<ToolResult, { status: 'ok' }>
export type ToolModelContentPart = ToolResultContent[number]

export interface ToolResultProjection {
  content: ToolModelContentPart[]
  isError: boolean
  truncated: boolean
}

export interface ToolDefinition<Schema extends TSchema = TSchema> {
  id: string
  description: string
  inputSchema: Schema
  batchPolicy?: ToolBatchPolicy
  effects: readonly Effect[]
  defaultRisk: 'low' | 'review' | 'high'
  supportsAbort: boolean
  defaultTimeoutMs: number
  maxOutputBytes: number
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
  runId: RunId
  workspace: {
    canonicalPath: string
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
