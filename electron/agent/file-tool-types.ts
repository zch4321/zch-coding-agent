import type { PolicySignal } from '../../shared/agent-events'

export type FileOperation = 'write' | 'patch' | 'delete'

export interface FilePrecondition {
  readonly kind: 'file'
  readonly operation: FileOperation
  readonly path: string
  readonly absolutePath: string
  readonly parentRealPath: string
  readonly expectedParentId: string
  readonly expectedExists: boolean
  readonly expectedRealPath?: string
  readonly expectedFileId?: string
  readonly expectedContentHash?: string
  readonly expectedContent?: string
  readonly patchHash?: string
  readonly expectedResultHash?: string
  readonly expectedResultContent?: string
}

export interface ToolResourcePlan {
  readonly preconditions: readonly FilePrecondition[]
  readonly policySignals: readonly PolicySignal[]
  readonly diff?: string
  readonly diffHash?: string
}
