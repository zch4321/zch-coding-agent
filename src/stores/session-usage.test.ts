// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentApi } from '../../shared/agent-api'
import type { SessionId } from '../../shared/ids'
import type { SessionUsageSnapshot } from '../../shared/session-usage'
import { useSessionUsageStore } from './session-usage'

const sessionId = 'session:usage-store' as SessionId
const otherId = 'session:other' as SessionId
function snapshot(id = sessionId, calls = 1): SessionUsageSnapshot {
  return {
    sessionId: id,
    context: null,
    all: { totals: { calls }, scopes: [] },
    currentRun: null,
    header: { main: null, totals: { calls: 0 } },
  }
}
function ok(value: SessionUsageSnapshot) {
  return { version: 1 as const, ok: true as const, value }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('session usage display cache', () => {
  it('restores numeric summaries on reload, replaces them from the backend, and keeps sessions isolated', async () => {
    const getSessionUsage = vi.fn(async ({ sessionId: id }) =>
      ok(snapshot(id, id === sessionId ? 3 : 7)),
    )
    Object.defineProperty(window, 'agentApi', {
      value: { getSessionUsage } as unknown as AgentApi,
      configurable: true,
    })
    const store = useSessionUsageStore()
    await store.refresh(sessionId)
    await store.refresh(otherId)
    setActivePinia(createPinia())
    const restored = useSessionUsageStore()
    restored.restore()
    expect(restored.snapshots[sessionId]?.all.totals.calls).toBe(3)
    expect(restored.snapshots[otherId]?.all.totals.calls).toBe(7)
    getSessionUsage.mockResolvedValueOnce(ok(snapshot(sessionId, 4)))
    await restored.refresh(sessionId)
    expect(restored.snapshots[sessionId]?.all.totals.calls).toBe(4)
    expect(restored.snapshots[otherId]?.all.totals.calls).toBe(7)
  })

  it('coalesces an in-flight invalidation and prevents deleted sessions from being resurrected', async () => {
    let resolve!: (value: ReturnType<typeof ok>) => void
    const getSessionUsage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      .mockResolvedValue(ok(snapshot(sessionId, 2)))
    Object.defineProperty(window, 'agentApi', {
      value: { getSessionUsage } as unknown as AgentApi,
      configurable: true,
    })
    const store = useSessionUsageStore()
    const first = store.refresh(sessionId)
    void store.refresh(sessionId)
    resolve(ok(snapshot()))
    await first
    expect(getSessionUsage).toHaveBeenCalledTimes(2)
    expect(store.snapshots[sessionId]?.all.totals.calls).toBe(2)
    getSessionUsage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const removed = store.refresh(sessionId)
    store.remove(sessionId)
    resolve(ok(snapshot()))
    await removed
    expect(store.snapshots[sessionId]).toBeUndefined()
    expect(localStorage.getItem('session-usage')).not.toContain(sessionId)
  })

  it('ignores corrupt storage and retains the previous display on a failed refresh', async () => {
    localStorage.setItem('session-usage', '{bad json')
    const getSessionUsage = vi
      .fn()
      .mockResolvedValueOnce(ok(snapshot()))
      .mockRejectedValueOnce(new Error('offline'))
    Object.defineProperty(window, 'agentApi', {
      value: { getSessionUsage } as unknown as AgentApi,
      configurable: true,
    })
    const store = useSessionUsageStore()
    await store.refresh(sessionId)
    await store.refresh(sessionId)
    expect(store.snapshots[sessionId]?.all.totals.calls).toBe(1)
  })
})
