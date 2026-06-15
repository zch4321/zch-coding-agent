import type { Static, TSchema } from '@sinclair/typebox'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'

export type Effect =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'process.spawn'
  | 'terminal.read'
  | 'terminal.write'
  | 'network.request'
  | 'instruction.read'
  | 'external.unknown'

export interface ToolDefinition<Schema extends TSchema = TSchema> {
  id: string
  description: string
  inputSchema: Schema
  effects: readonly Effect[]
  defaultRisk: 'low' | 'review' | 'high'
  supportsAbort: boolean
  defaultTimeoutMs: number
  maxOutputBytes: number
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
  signal: AbortSignal
  approvedCall: unknown
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
