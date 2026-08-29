import type { PathGuardRootKind } from './path-guard'

export type FileOperation = 'write' | 'patch' | 'delete'

/** Captures the filesystem identity and content facts approved for one mutation. */
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
