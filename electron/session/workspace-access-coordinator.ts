import type { PermissionMode } from '../../shared/config'
import type { RunId, SessionId } from '../../shared/ids'

export interface RunWorkspaceWriterOwner {
  kind: 'provider_run'
  workspace: string
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

interface QueuedRunAccessRequest {
  input: {
    limit: number
    workspace: string
    mode: 'readonly'
    sessionId: SessionId
    runId: RunId
  }
  signal: AbortSignal
  resolve: (lease: RunAccessLease) => void
  reject: (error: unknown) => void
  onAbort: () => void
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
  readonly #queuedRuns: QueuedRunAccessRequest[] = []
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

  /** Acquires a bounded workspace run/write lease for a Session and operation. */
  acquire(input: {
    limit: number
    workspace: string
    mode: PermissionMode
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
      this.#drainQueuedRuns()
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

  /** Waits in FIFO order for a run slot while preserving normal fail-fast acquisition. */
  acquireQueued(
    input: {
      limit: number
      workspace: string
      mode: 'readonly'
      sessionId: SessionId
      runId: RunId
    },
    signal: AbortSignal,
  ): Promise<RunAccessLease> {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason ?? new Error('Run slot wait cancelled'),
      )
    }
    if (this.#queuedRuns.length === 0) {
      const immediate = this.acquire(input)
      if (immediate.acquired) return Promise.resolve(immediate.lease)
      if (immediate.rejection.reason !== 'max_concurrent_runs') {
        return Promise.reject(
          new Error('Workspace writer access is unavailable'),
        )
      }
    }
    return new Promise<RunAccessLease>((resolve, reject) => {
      const request = {
        input: { ...input },
        signal,
        resolve,
        reject,
        onAbort: () => undefined,
      } satisfies QueuedRunAccessRequest
      request.onAbort = () => {
        const index = this.#queuedRuns.indexOf(request)
        if (index >= 0) this.#queuedRuns.splice(index, 1)
        reject(signal.reason ?? new Error('Run slot wait cancelled'))
      }
      signal.addEventListener('abort', request.onAbort, { once: true })
      this.#queuedRuns.push(request)
      this.#drainQueuedRuns()
    })
  }

  /** Acquires exclusive workspace writer access for a file-change revert operation. */
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

  /** Returns the current workspace writer ownership snapshot. */
  writerFor(workspace: string): WorkspaceWriterOwner | undefined {
    const owner = this.#writers.get(workspace)
    return owner ? { ...owner } : undefined
  }

  /** Returns the number of active workspace run leases. */
  activeRunCount(): number {
    return this.#activeRuns.size
  }

  /** Releases all run and writer leases and waits for pending releases to settle. */
  releaseAll(): void {
    const writers = [...this.#writers.values()]
    this.#activeRuns.clear()
    this.#writers.clear()
    const queued = this.#queuedRuns.splice(0)
    for (const request of queued) {
      request.signal.removeEventListener('abort', request.onAbort)
      request.reject(new Error('Workspace access coordinator was released'))
    }
    for (const owner of writers) {
      this.#onWriterChanged('released', owner)
    }
  }

  #drainQueuedRuns(): void {
    while (this.#queuedRuns.length > 0) {
      const request = this.#queuedRuns[0]!
      if (request.signal.aborted) {
        this.#queuedRuns.shift()
        request.signal.removeEventListener('abort', request.onAbort)
        request.reject(
          request.signal.reason ?? new Error('Run slot wait cancelled'),
        )
        continue
      }
      const acquired = this.acquire(request.input)
      if (!acquired.acquired) {
        if (acquired.rejection.reason === 'max_concurrent_runs') return
        this.#queuedRuns.shift()
        request.signal.removeEventListener('abort', request.onAbort)
        request.reject(new Error('Workspace writer access is unavailable'))
        continue
      }
      this.#queuedRuns.shift()
      request.signal.removeEventListener('abort', request.onAbort)
      request.resolve(acquired.lease)
    }
  }
}
