// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type {
  BackgroundTaskPage,
  BackgroundTerminal,
} from '../../shared/background-tasks'
import type { SessionId, TerminalId } from '../../shared/ids'
import { useAgentReplicaStore } from './agent-replica'
import { useBackgroundTaskStore } from './background-tasks'

const sessionId = 'session:background' as SessionId
const terminal: BackgroundTerminal = {
  kind: 'terminal',
  terminalId: 1 as TerminalId,
  shell: 'pwsh',
  status: 'running',
  exitCode: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  artifactAvailable: true,
}
function page(
  sequence: number,
  overrides: Partial<BackgroundTaskPage> = {},
): BackgroundTaskPage {
  return {
    cursor: { backendInstanceId: 'backend:test', sequence },
    records: [terminal],
    hasMore: false,
    activeCount: 1,
    ...overrides,
  }
}
function success(value: BackgroundTaskPage) {
  return { version: 1 as const, ok: true as const, value }
}

describe('Background task store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentReplicaStore().selectedSessionId = sessionId
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('loads without a bottom terminal and uses the backend count independently of page size', async () => {
    const listBackgroundTasks = vi.fn(async () =>
      success(page(1, { activeCount: 80, hasMore: true, nextBefore: 'more' })),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { listBackgroundTasks } as unknown as AgentApi,
    })
    const store = useBackgroundTaskStore()
    await store.load(sessionId)
    expect(store.selectedRecords).toHaveLength(1)
    expect(store.selectedActiveCount).toBe(80)
    listBackgroundTasks.mockResolvedValueOnce(
      success(
        page(2, {
          records: [terminal, { ...terminal, terminalId: 2 as TerminalId }],
        }),
      ),
    )
    await store.load(sessionId, { append: true })
    expect(store.selectedRecords).toHaveLength(2)
    expect(listBackgroundTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 'more' }),
    )
  })

  it('refreshes past an invalidated snapshot instead of restoring an old running state', async () => {
    let resolve!: (value: ReturnType<typeof success>) => void
    const pending = new Promise<ReturnType<typeof success>>((done) => {
      resolve = done
    })
    const listBackgroundTasks = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(
        success(
          page(3, {
            records: [{ ...terminal, status: 'closed' }],
            activeCount: 0,
          }),
        ),
      )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { listBackgroundTasks } as unknown as AgentApi,
    })
    const store = useBackgroundTaskStore()
    const loading = store.load(sessionId)
    store.handleEvent({ parentSessionId: sessionId, cursor: page(3).cursor })
    resolve(success(page(1)))
    await loading
    await vi.waitFor(() => expect(store.selectedActiveCount).toBe(0))
    await vi.waitFor(() =>
      expect(store.selectedRecords[0]).toMatchObject({ status: 'closed' }),
    )
    expect(listBackgroundTasks).toHaveBeenCalledTimes(2)
  })

  it('keeps a late response scoped to its conversation and rejects retired-instance responses', async () => {
    let resolve!: (value: ReturnType<typeof success>) => void
    const pending = new Promise<ReturnType<typeof success>>((done) => {
      resolve = done
    })
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listBackgroundTasks: vi.fn(() => pending),
      } as unknown as AgentApi,
    })
    const store = useBackgroundTaskStore()
    store.acceptCursor(page(0).cursor)
    const loading = store.load(sessionId)
    store.acceptCursor({ backendInstanceId: 'backend:new', sequence: 0 })
    useAgentReplicaStore().selectedSessionId = 'session:other' as SessionId
    resolve(success(page(9)))
    await loading
    expect(store.selectedRecords).toEqual([])
    expect(store.backendInstanceId).toBe('backend:new')
  })

  it('keeps accepted cancellation pending and allows retry after a failure', async () => {
    const cancelBackgroundTask = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'close failed' },
      })
      .mockResolvedValueOnce({
        version: 1,
        ok: true,
        value: { accepted: true },
      })
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        cancelBackgroundTask,
        listBackgroundTasks: vi.fn(async () => success(page(1))),
      } as unknown as AgentApi,
    })
    const store = useBackgroundTaskStore()
    await store.load(sessionId)
    await store.stop(sessionId, {
      kind: 'terminal',
      terminalId: terminal.terminalId,
    })
    expect(store.stops['terminal:1']?.error).toBe('close failed')
    await store.stop(sessionId, {
      kind: 'terminal',
      terminalId: terminal.terminalId,
    })
    expect(store.stops['terminal:1']).toMatchObject({
      pending: false,
      accepted: true,
    })
    expect(store.selectedRecords[0]).toMatchObject({ status: 'running' })
    expect(cancelBackgroundTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backendInstanceId: 'backend:test',
        parentSessionId: sessionId,
      }),
    )
  })
})
