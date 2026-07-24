import type { PermissionMode } from '../../shared/config'
import type { RunId, SessionId } from '../../shared/ids'

export interface RunWorkspaceWriterOwner {
  kind: 'provider_run'
  workspace: string
  conversationId: string
  sessionId: SessionId
  runId: RunId
}

export interface FileChangeRevertWriterOwner {
  kind: 'file_change_revert'
  workspace: string
  sessionId: SessionId
  operationId: string
}

export type WorkspaceWriterOwner =
  | RunWorkspaceWriterOwner
  | FileChangeRevertWriterOwner

export type RunAccessRejection =
  | {
      reason: 'max_concurrent_runs'
      limit: number
      active: number
    }
  | {
      reason: 'workspace_writer_active'
      writer: WorkspaceWriterOwner
    }

export type RunAccessResult =
  | { acquired: true; lease: RunAccessLease }
  | { acquired: false; rejection: RunAccessRejection }

export interface RunAccessLease {
  releaseRunSlot: () => void
  releaseWriter: () => void
  release: () => void
}

export type FileChangeRevertAccessResult =
  | { acquired: true; release: () => void }
  | {
      acquired: false
      rejection: Extract<
        RunAccessRejection,
        { reason: 'workspace_writer_active' }
      >
    }

/**
 * Coordinates the process-wide run budget and the single writer invariant for
 * each canonical workspace. Acquisition and release are synchronous so two
 * IPC requests can never observe a gap between the capacity and writer checks.
 */
export class WorkspaceAccessCoordinator {
  readonly #activeRuns = new Map<RunId, RunWorkspaceWriterOwner | undefined>()
  readonly #writers = new Map<string, WorkspaceWriterOwner>()
  readonly #onWriterChanged: (
    status: 'acquired' | 'released',
    owner: WorkspaceWriterOwner,
  ) => void

  constructor(options?: {
    onWriterChanged?: (
      status: 'acquired' | 'released',
      owner: WorkspaceWriterOwner,
    ) => void
  }) {
    this.#onWriterChanged = options?.onWriterChanged ?? (() => undefined)
  }

  acquire(input: {
    limit: number
    workspace: string
    mode: PermissionMode
    conversationId: string
    sessionId: SessionId
    runId: RunId
  }): RunAccessResult {
    if (this.#activeRuns.size >= input.limit) {
      return {
        acquired: false,
        rejection: {
          reason: 'max_concurrent_runs',
          limit: input.limit,
          active: this.#activeRuns.size,
        },
      }
    }

    const owner: RunWorkspaceWriterOwner = {
      kind: 'provider_run',
      workspace: input.workspace,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      runId: input.runId,
    }
    const mutating = input.mode !== 'readonly'
    const currentWriter = mutating
      ? this.#writers.get(input.workspace)
      : undefined

    if (currentWriter) {
      return {
        acquired: false,
        rejection: {
          reason: 'workspace_writer_active',
          writer: currentWriter,
        },
      }
    }

    this.#activeRuns.set(input.runId, mutating ? owner : undefined)
    if (mutating) {
      this.#writers.set(input.workspace, owner)
      this.#onWriterChanged('acquired', owner)
    }

    let runSlotReleased = false
    let writerReleased = false
    const releaseRunSlot = () => {
      if (runSlotReleased) return
      runSlotReleased = true
      this.#activeRuns.delete(input.runId)
    }
    const releaseWriter = () => {
      if (writerReleased) return
      writerReleased = true

      const runOwner = mutating ? owner : undefined
      if (runOwner && this.#writers.get(runOwner.workspace) === runOwner) {
        this.#writers.delete(runOwner.workspace)
        this.#onWriterChanged('released', runOwner)
      }
    }
    return {
      acquired: true,
      lease: {
        releaseRunSlot,
        releaseWriter,
        release: () => {
          releaseRunSlot()
          releaseWriter()
        },
      },
    }
  }

  acquireFileChangeRevert(input: {
    workspace: string
    sessionId: SessionId
    operationId: string
  }): FileChangeRevertAccessResult {
    const currentWriter = this.#writers.get(input.workspace)
    if (currentWriter) {
      return {
        acquired: false,
        rejection: {
          reason: 'workspace_writer_active',
          writer: { ...currentWriter },
        },
      }
    }
    const owner: FileChangeRevertWriterOwner = {
      kind: 'file_change_revert',
      workspace: input.workspace,
      sessionId: input.sessionId,
      operationId: input.operationId,
    }
    this.#writers.set(input.workspace, owner)
    this.#onWriterChanged('acquired', owner)
    let released = false
    return {
      acquired: true,
      release: () => {
        if (released) return
        released = true
        if (this.#writers.get(owner.workspace) !== owner) return
        this.#writers.delete(owner.workspace)
        this.#onWriterChanged('released', owner)
      },
    }
  }

  writerFor(workspace: string): WorkspaceWriterOwner | undefined {
    const owner = this.#writers.get(workspace)
    return owner ? { ...owner } : undefined
  }

  activeRunCount(): number {
    return this.#activeRuns.size
  }

  releaseAll(): void {
    const writers = [...this.#writers.values()]
    this.#activeRuns.clear()
    this.#writers.clear()
    for (const owner of writers) {
      this.#onWriterChanged('released', owner)
    }
  }
}
