import type { PolicySignal } from '../../shared/agent-events'
import type { FilePrecondition } from '../safety/file-precondition'

export type {
  FileOperation,
  FilePrecondition,
} from '../safety/file-precondition'

export interface ToolResourcePlan {
  readonly preconditions: readonly FilePrecondition[]
  readonly policySignals: readonly PolicySignal[]
  readonly scratchMutation?: boolean
  readonly diff?: string
  readonly diffHash?: string
}
