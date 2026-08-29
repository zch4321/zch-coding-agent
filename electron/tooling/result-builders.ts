import type { JsonValue } from '../../shared/json'
import type { ToolResult } from './contracts'

export interface ToolSuccessOptions {
  truncated?: boolean
  totalBytes?: number
}

/** Creates one successful internal Tool result without applying model projection. */
export function createToolSuccess(
  content: JsonValue,
  options: ToolSuccessOptions = {},
): ToolResult {
  return {
    status: 'ok',
    content,
    ...(options.truncated === undefined
      ? {}
      : { truncated: options.truncated }),
    ...(options.totalBytes === undefined
      ? {}
      : { totalBytes: options.totalBytes }),
  }
}

/** Creates one structured Tool failure with an explicit retry contract. */
export function createToolError(
  code: string,
  message: string,
  retryable = false,
): ToolResult {
  return { status: 'error', code, message, retryable }
}

/** Creates one Tool result rejected by the permission boundary. */
export function createToolDenied(message: string): ToolResult {
  return { status: 'denied', message }
}

/** Creates one Tool result cancelled by its owning Run. */
export function createToolCancelled(
  message = 'The run was cancelled',
): ToolResult {
  return { status: 'cancelled', message }
}

/** Creates one Tool result whose configured execution deadline expired. */
export function createToolTimeout(toolId: string): ToolResult {
  return { status: 'timeout', message: `${toolId} timed out` }
}
