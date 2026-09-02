import type { PolicySignal } from '../../shared/agent-events'
export type FileOperation = 'write' | 'patch' | 'delete'

export interface ToolResourcePlan {
  readonly policySignals: readonly PolicySignal[]
  readonly scratchMutation?: boolean
}
