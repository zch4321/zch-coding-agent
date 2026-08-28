import type { PolicySignal } from '../../shared/agent-events'
import type { PathGuardRootKind } from '../safety/path-guard'

export type FileOperation = 'write' | 'patch' | 'delete'

export interface FilePrecondition {
  readonly kind: 'file'
  readonly operation: FileOperation
  readonly rootKind: PathGuardRootKind
  readonly rootPath: string
  readonly path: string
  readonly absolutePath: string
  readonly parentRealPath: string
  readonly expectedParentId: string
  readonly expectedParentExists?: boolean
  readonly expectedExistingParentRealPath?: string
  readonly expectedExistingParentId?: string
  readonly expectedExists: boolean
  readonly expectedMode?: number
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
  readonly scratchMutation?: boolean
  readonly diff?: string
  readonly diffHash?: string
}
