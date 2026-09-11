import type { RunId, SessionId } from '../../shared/ids'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { ContextEntry } from '../../shared/session-usage'
import type { LlmUsageRecord } from '../../shared/usage'

export interface UsageCallInput {
  sessionId: SessionId
  runId: RunId
  callId: string
  usage: LlmUsageRecord
}

export interface UsageRecorder {
  /** Records one normalized source call without controlling Session lifecycle. */
  record(input: UsageCallInput): Promise<void>
}

export interface UsageRunLifecycle {
  /** Selects the current Run before any auxiliary calls can complete. */
  startRun(sessionId: SessionId, runId: RunId): Promise<void>
}

export interface ContextToolUsage {
  bytes: number
  count: number
  entries: ContextEntry[]
}

export interface ContextUsageInput {
  sessionId: SessionId
  runId: RunId
  route: ModelRouteSnapshot
  tools?: ContextToolUsage
}

export interface UsageContextCapture {
  /** Combines immutable route/tool metadata with authoritative committed history. */
  capture(input: ContextUsageInput): Promise<void>
}

export type SessionUsagePort = UsageRecorder &
  UsageRunLifecycle &
  UsageContextCapture
