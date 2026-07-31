export interface WorkspaceSnapshotIdentity {
  schemaVersion: 1
  sourceHash: string
  fileCount: number
  totalBytes: number
  skippedDirectories: string[]
  git?: {
    head?: string
    symbolicHead?: string
    refsHash: string
    indexHash: string
    statusHash: string
  }
}

export interface WorkspaceSnapshot {
  workspace: string
  gitAvailable: boolean
  identity: WorkspaceSnapshotIdentity
  dispose(): Promise<void>
}

/** Reports a bounded, safe failure while preparing an immutable Subagent source view. */
export class WorkspaceSnapshotError extends Error {
  constructor(
    readonly code:
      | 'SNAPSHOT_CHANGED'
      | 'SNAPSHOT_LIMIT'
      | 'SNAPSHOT_TIMEOUT'
      | 'SNAPSHOT_UNSAFE_FILE'
      | 'SNAPSHOT_GIT_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceSnapshotError'
  }
}
