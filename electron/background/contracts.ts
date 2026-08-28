import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { SessionTempPaths } from '../session-temp/service'

export type BackgroundTargetType = 'subagent' | 'swarm' | 'terminal'

export interface BackgroundTarget {
  type: BackgroundTargetType
  id: string
}

export interface BackgroundRequestContext {
  parentSessionId: SessionId
  sessionTemp: SessionTempPaths
  signal: AbortSignal
  outputLimits?: {
    maxToolOutputBytes: number
    maxToolOutputLines: number
  }
}

export interface BackgroundWaitInput extends BackgroundRequestContext {
  targets: BackgroundTarget[]
  mode: 'any' | 'all'
  timeoutMs: number
}

export interface BackgroundListInput extends BackgroundRequestContext {
  types?: BackgroundTargetType[]
  status: 'active' | 'finished' | 'all'
  limit: number
  cursor?: string
}

export interface BackgroundCancelInput extends BackgroundRequestContext {
  target: BackgroundTarget
  waitMs: number
}

/** Executes parent-scoped discovery, waiting, and cancellation for background tasks. */
export interface BackgroundTaskPort {
  wait(input: BackgroundWaitInput): Promise<JsonValue>
  list(input: BackgroundListInput): Promise<JsonValue>
  cancel(input: BackgroundCancelInput): Promise<JsonValue>
  cancelSession(parentSessionId: SessionId): Promise<void>
}

/** Carries stable background-tool errors through Tool Result normalization. */
export class BackgroundTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BackgroundTaskError'
  }
}

/** Narrows a validated opaque background target string to an execution ID. */
export function agentExecutionId(value: string): AgentExecutionId {
  return value as AgentExecutionId
}
