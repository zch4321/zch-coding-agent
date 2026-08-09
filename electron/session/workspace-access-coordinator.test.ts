import { describe, expect, it, vi } from 'vitest'
import type { RunId, SessionId } from '../../shared/ids'
import { WorkspaceAccessCoordinator } from './workspace-access-coordinator'

function owner(index: number, workspace = '/workspace') {
  return {
    limit: 4,
    workspace,
    mode: 'auto' as const,
    sessionId: `session:${index}` as SessionId,
    runId: `run:${index}` as RunId,
  }
}

describe('WorkspaceAccessCoordinator', () => {
  it('allows one writer and concurrent readers in the same workspace', () => {
    const changed = vi.fn()
    const coordinator = new WorkspaceAccessCoordinator({
      onWriterChanged: changed,
    })
    const writer = coordinator.acquire(owner(1))
    const reader = coordinator.acquire({
      ...owner(2),
      mode: 'readonly',
    })
    const conflict = coordinator.acquire(owner(3))

    expect(writer.acquired).toBe(true)
    expect(reader.acquired).toBe(true)
    expect(conflict).toMatchObject({
      acquired: false,
      rejection: {
        reason: 'workspace_writer_active',
        writer: { sessionId: 'session:1', runId: 'run:1' },
      },
    })
    expect(coordinator.activeRunCount()).toBe(2)
    expect(changed).toHaveBeenCalledWith(
      'acquired',
      expect.objectContaining({ runId: 'run:1' }),
    )

    if (writer.acquired) writer.lease.release()
    if (reader.acquired) reader.lease.release()
    expect(changed).toHaveBeenLastCalledWith(
      'released',
      expect.objectContaining({ runId: 'run:1' }),
    )
  })

  it('allows independent writers in different workspaces', () => {
    const coordinator = new WorkspaceAccessCoordinator()
    expect(coordinator.acquire(owner(1, '/workspace/a')).acquired).toBe(true)
    expect(coordinator.acquire(owner(2, '/workspace/b')).acquired).toBe(true)
  })

  it('hard rejects a fifth active run', () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const leases = [1, 2, 3, 4].map((index) =>
      coordinator.acquire({
        ...owner(index, `/workspace/${index}`),
        mode: 'readonly',
      }),
    )
    expect(leases.every((lease) => lease.acquired)).toBe(true)
    expect(
      coordinator.acquire({
        ...owner(5, '/workspace/5'),
        mode: 'readonly',
      }),
    ).toEqual({
      acquired: false,
      rejection: { reason: 'max_concurrent_runs', limit: 4, active: 4 },
    })
  })

  it('releases writer ownership idempotently', () => {
    const changed = vi.fn()
    const coordinator = new WorkspaceAccessCoordinator({
      onWriterChanged: changed,
    })
    const lease = coordinator.acquire(owner(1))
    if (!lease.acquired) throw new Error('Expected writer lease')

    lease.lease.release()
    lease.lease.release()

    expect(coordinator.activeRunCount()).toBe(0)
    expect(coordinator.writerFor('/workspace')).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('releases the run slot without releasing a writer still settling work', () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const lease = coordinator.acquire(owner(1))
    if (!lease.acquired) throw new Error('Expected writer lease')

    lease.lease.releaseRunSlot()

    expect(coordinator.activeRunCount()).toBe(0)
    expect(coordinator.writerFor('/workspace')).toMatchObject({
      runId: 'run:1',
    })
    expect(coordinator.acquire(owner(2))).toMatchObject({
      acquired: false,
      rejection: { reason: 'workspace_writer_active' },
    })

    lease.lease.releaseWriter()
    expect(coordinator.writerFor('/workspace')).toBeUndefined()
  })

  it('shares writer exclusion with revert without consuming a run slot', () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const revert = coordinator.acquireFileChangeRevert({
      workspace: '/workspace',
      sessionId: 'session:revert' as SessionId,
      operationId: 'revert:1',
    })
    expect(revert).toMatchObject({ acquired: true })
    expect(coordinator.activeRunCount()).toBe(0)
    expect(coordinator.writerFor('/workspace')).toEqual({
      kind: 'file_change_revert',
      workspace: '/workspace',
      sessionId: 'session:revert',
      operationId: 'revert:1',
    })
    expect(coordinator.acquire(owner(1))).toMatchObject({
      acquired: false,
      rejection: {
        reason: 'workspace_writer_active',
        writer: { kind: 'file_change_revert', operationId: 'revert:1' },
      },
    })
    expect(
      coordinator.acquire({
        ...owner(2),
        mode: 'readonly',
      }).acquired,
    ).toBe(true)
    expect(coordinator.acquire(owner(3, '/workspace/other')).acquired).toBe(
      true,
    )

    if (revert.acquired) {
      revert.release()
      revert.release()
    }
    expect(coordinator.writerFor('/workspace')).toBeUndefined()
  })

  it('rejects revert while a provider writer owns the workspace', () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const run = coordinator.acquire(owner(1))
    expect(run.acquired).toBe(true)
    expect(
      coordinator.acquireFileChangeRevert({
        workspace: '/workspace',
        sessionId: 'session:revert' as SessionId,
        operationId: 'revert:2',
      }),
    ).toMatchObject({
      acquired: false,
      rejection: {
        reason: 'workspace_writer_active',
        writer: { kind: 'provider_run', runId: 'run:1' },
      },
    })
  })

  it('grants queued readonly slots in FIFO order while normal runs stay fail-fast', async () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const first = coordinator.acquire({
      ...owner(1),
      limit: 1,
      mode: 'readonly',
    })
    if (!first.acquired) throw new Error('Expected first reader lease')
    const order: number[] = []
    const second = coordinator
      .acquireQueued(
        { ...owner(2), limit: 1, mode: 'readonly' },
        new AbortController().signal,
      )
      .then((lease) => {
        order.push(2)
        return lease
      })
    const third = coordinator
      .acquireQueued(
        { ...owner(3), limit: 1, mode: 'readonly' },
        new AbortController().signal,
      )
      .then((lease) => {
        order.push(3)
        return lease
      })

    expect(
      coordinator.acquire({ ...owner(4), limit: 1, mode: 'readonly' }),
    ).toMatchObject({
      acquired: false,
      rejection: { reason: 'max_concurrent_runs' },
    })
    first.lease.release()
    const secondLease = await second
    expect(order).toEqual([2])
    secondLease.release()
    const thirdLease = await third
    expect(order).toEqual([2, 3])
    thirdLease.release()
  })

  it('removes an aborted queued request without blocking the next request', async () => {
    const coordinator = new WorkspaceAccessCoordinator()
    const first = coordinator.acquire({
      ...owner(1),
      limit: 1,
      mode: 'readonly',
    })
    if (!first.acquired) throw new Error('Expected first reader lease')
    const abort = new AbortController()
    const cancelled = coordinator.acquireQueued(
      { ...owner(2), limit: 1, mode: 'readonly' },
      abort.signal,
    )
    const next = coordinator.acquireQueued(
      { ...owner(3), limit: 1, mode: 'readonly' },
      new AbortController().signal,
    )

    abort.abort(new Error('cancelled'))
    await expect(cancelled).rejects.toThrow('cancelled')
    first.lease.release()
    const nextLease = await next
    expect(coordinator.activeRunCount()).toBe(1)
    nextLease.release()
  })
})
