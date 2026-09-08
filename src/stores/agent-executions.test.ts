// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type {
  AgentExecutionDetail,
  AgentExecutionEvent,
  AgentExecutionSummary,
} from '../../shared/agent-execution'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { useAgentExecutionStore } from './agent-executions'
import { useAgentReplicaStore } from './agent-replica'

const timestamp = '2026-08-01T00:00:00.000Z'
const parentSessionId = 'session:agent-store' as SessionId

function summary(
  id: string,
  status: AgentExecutionSummary['status'],
  createdAt = timestamp,
): AgentExecutionSummary {
  return {
    schemaVersion: 1,
    id: id as AgentExecutionId,
    kind: 'subagent',
    parentSessionId,
    parentRunId: `run:${id}` as RunId,
    parentCallId: `call:${id}` as CallId,
    name: id,
    status,
    createdAt,
    updatedAt: createdAt,
    ...(status === 'queued' || status === 'preparing' || status === 'running'
      ? {}
      : { completedAt: createdAt }),
  }
}

function detail(value: AgentExecutionSummary): AgentExecutionDetail {
  return {
    schemaVersion: 1,
    summary: value,
    task: `Task for ${value.name}`,
    statistics: { toolCallCount: 0 },
    activityPage: {
      schemaVersion: 1,
      records: [],
      hasMore: false,
    },
  }
}

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

function eventBase(
  execution: AgentExecutionSummary,
  seq: number,
): Pick<
  AgentExecutionEvent,
  | 'schemaVersion'
  | 'seq'
  | 'ts'
  | 'executionId'
  | 'parentSessionId'
  | 'parentRunId'
  | 'parentCallId'
> {
  return {
    schemaVersion: 1,
    seq,
    ts: timestamp,
    executionId: execution.id,
    parentSessionId: execution.parentSessionId,
    parentRunId: execution.parentRunId,
    parentCallId: execution.parentCallId,
  }
}

describe('agent execution store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentReplicaStore().selectedSessionId = parentSessionId
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('does not let an older list snapshot overwrite a completed event', async () => {
    const running = summary('subagent:late-list', 'running')
    let resolve!: (
      value: ReturnType<
        typeof success<{
          page: {
            schemaVersion: 1
            records: AgentExecutionSummary[]
            hasMore: boolean
            cursor: { backendInstanceId: string; sequence: number }
          }
        }>
      >,
    ) => void
    const pending = new Promise<Parameters<typeof resolve>[0]>((done) => {
      resolve = done
    })
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listAgentExecutions: vi.fn(() => pending),
      } as unknown as AgentApi,
    })
    const store = useAgentExecutionStore()
    store.upsertSummary(running, {
      backendInstanceId: 'backend:race',
      sequence: 0,
    })
    const loading = store.loadSession(parentSessionId, { force: true })
    store.handleEvent({
      ...eventBase(running, 1),
      cursor: { backendInstanceId: 'backend:race', sequence: 2 },
      type: 'execution.changed',
      summary: { ...running, status: 'completed' },
    })
    resolve(
      success({
        page: {
          schemaVersion: 1,
          records: [running],
          hasMore: false,
          cursor: { backendInstanceId: 'backend:race', sequence: 1 },
        },
      }),
    )
    await loading
    expect(store.selectedExecutions[0]?.status).toBe('completed')
  })

  it('repairs a missing delta from a snapshot then replays later deltas exactly once', async () => {
    const running = summary('subagent:watermark', 'running')
    const cursor = (sequence: number) => ({
      backendInstanceId: 'backend:watermark',
      sequence,
    })
    let resolve!: (
      value: ReturnType<typeof success<{ detail: AgentExecutionDetail }>>,
    ) => void
    const pending = new Promise<Parameters<typeof resolve>[0]>((done) => {
      resolve = done
    })
    const getAgentExecution = vi.fn(() => pending)
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listAgentExecutions: vi.fn(async () =>
          success({
            page: {
              schemaVersion: 1,
              records: [running],
              hasMore: false,
              cursor: cursor(3),
            },
          }),
        ),
        getAgentExecution,
      } as unknown as AgentApi,
    })
    const store = useAgentExecutionStore()
    store.upsertSummary(running, cursor(0))
    store.handleEvent({
      ...eventBase(running, 1),
      cursor: cursor(1),
      type: 'assistant.text.delta',
      delta: 'A',
    })
    store.handleEvent({
      ...eventBase(running, 3),
      cursor: cursor(3),
      type: 'assistant.text.delta',
      delta: 'C',
    })
    await vi.waitFor(() => expect(getAgentExecution).toHaveBeenCalledOnce())
    store.handleEvent({
      ...eventBase(running, 4),
      cursor: cursor(4),
      type: 'assistant.text.delta',
      delta: 'D',
    })
    resolve(
      success({
        detail: {
          ...detail(running),
          cursor: cursor(3),
          eventSeq: 3,
          live: {
            schemaVersion: 1,
            status: 'calling_llm',
            text: 'ABC',
            reasoning: '',
            tools: [],
          },
        },
      }),
    )
    await vi.waitFor(() => expect(store.live[running.id]?.text).toBe('ABCD'))
    store.handleEvent({
      ...eventBase(running, 5),
      cursor: cursor(5),
      type: 'assistant.text.delta',
      delta: 'E',
    })
    expect(store.live[running.id]?.text).toBe('ABCDE')
    expect(store.recoveryPending[running.id]).toBe(false)
  })

  it('ignores a retired backend instance after adopting a new one', () => {
    const running = summary('subagent:restart', 'running')
    const store = useAgentExecutionStore()
    store.upsertSummary(running, { backendInstanceId: 'old', sequence: 8 })
    store.acceptCursor({ backendInstanceId: 'new', sequence: 0 })
    store.handleEvent({
      ...eventBase(running, 9),
      cursor: { backendInstanceId: 'old', sequence: 9 },
      type: 'execution.changed',
      summary: running,
    })
    expect(store.selectedExecutions).toEqual([])
    expect(store.backendInstanceId).toBe('new')
  })

  it('ignores late events older than a complete snapshot even if its per-execution counter was evicted', async () => {
    const completed = summary('subagent:evicted-sequence', 'completed')
    const store = useAgentExecutionStore()
    store.upsertSummary(completed, {
      backendInstanceId: 'backend:eviction',
      sequence: 50,
    })
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getAgentExecution: vi.fn(async () =>
          success({
            detail: {
              ...detail(completed),
              cursor: { backendInstanceId: 'backend:eviction', sequence: 100 },
              eventSeq: 0,
            },
          }),
        ),
      } as unknown as AgentApi,
    })
    await store.loadDetail(completed.id)
    store.handleEvent({
      ...eventBase(completed, 1),
      cursor: { backendInstanceId: 'backend:eviction', sequence: 90 },
      type: 'assistant.text.delta',
      delta: 'obsolete output',
    })
    expect(store.live[completed.id]?.text).toBe('')
    expect(store.live[completed.id]?.lastEventSeq).toBe(0)
  })

  it('bounds buffered events and obtains a fresh snapshot after overflow', async () => {
    const running = summary('subagent:overflow', 'running')
    const cursor = (sequence: number) => ({
      backendInstanceId: 'backend:overflow',
      sequence,
    })
    const finalText = 'A' + 'x'.repeat(299)
    const snapshot = (sequence: number, text: string) =>
      success({
        detail: {
          ...detail(running),
          cursor: cursor(sequence),
          eventSeq: sequence,
          live: {
            schemaVersion: 1 as const,
            status: 'calling_llm' as const,
            text,
            reasoning: '',
            tools: [],
          },
        },
      })
    let resolve!: (value: ReturnType<typeof snapshot>) => void
    const pending = new Promise<ReturnType<typeof snapshot>>((done) => {
      resolve = done
    })
    const getAgentExecution = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(snapshot(300, finalText))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { getAgentExecution } as unknown as AgentApi,
    })
    const store = useAgentExecutionStore()
    store.upsertSummary(running, cursor(0))
    store.handleEvent({
      ...eventBase(running, 1),
      cursor: cursor(1),
      type: 'assistant.text.delta',
      delta: 'A',
    })
    const loading = store.loadDetail(running.id)
    for (let seq = 2; seq <= 300; seq += 1)
      store.handleEvent({
        ...eventBase(running, seq),
        cursor: cursor(seq),
        type: 'assistant.text.delta',
        delta: 'x',
      })
    expect(store.requestEvents[running.id]!.length).toBeLessThanOrEqual(256)
    resolve(snapshot(1, 'A'))
    await loading
    await vi.waitFor(() =>
      expect(store.details[running.id]?.detail?.cursor?.sequence).toBe(300),
    )
    expect(getAgentExecution).toHaveBeenCalledTimes(2)
    expect(store.live[running.id]?.text).toBe(finalText)
  })

  it('sorts active executions first, paginates, and isolates Session views', async () => {
    const completed = summary(
      'subagent:completed',
      'completed',
      '2026-08-01T00:02:00.000Z',
    )
    const active = summary(
      'subagent:active',
      'running',
      '2026-08-01T00:01:00.000Z',
    )
    const older = summary(
      'subagent:older',
      'completed',
      '2026-08-01T00:00:00.000Z',
    )
    const listAgentExecutions = vi
      .fn()
      .mockResolvedValueOnce(
        success({
          page: {
            schemaVersion: 1,
            records: [completed, active],
            hasMore: true,
            nextBefore: {
              createdAt: active.createdAt,
              executionId: active.id,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        success({
          page: {
            schemaVersion: 1,
            records: [older],
            hasMore: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        success({
          page: { schemaVersion: 1, records: [], hasMore: false },
        }),
      )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { listAgentExecutions } as Partial<AgentApi> as AgentApi,
    })
    const store = useAgentExecutionStore()

    expect(await store.loadSession(parentSessionId)).toBe(true)
    expect(store.selectedExecutions.map((record) => record.id)).toEqual([
      active.id,
      completed.id,
    ])
    expect(store.selectedActiveCount).toBe(1)
    expect(await store.loadSession(parentSessionId, { append: true })).toBe(
      true,
    )
    expect(store.selectedExecutions.map((record) => record.id)).toEqual([
      active.id,
      completed.id,
      older.id,
    ])
    expect(listAgentExecutions.mock.calls[1]?.[0]).toMatchObject({
      before: { executionId: active.id },
    })

    const other = 'session:agent-store-other' as SessionId
    useAgentReplicaStore().selectedSessionId = other
    expect(await store.loadSession(other)).toBe(true)
    expect(store.selectedExecutions).toEqual([])
    expect(store.selectedActiveCount).toBe(0)

    store.details[active.id] = { loaded: false, loading: false }
    store.live[active.id] = {
      lastEventSeq: 0,
      generation: 0,
      text: '',
      reasoning: '',
      activities: [],
      usage: [],
      approvalSubmitting: false,
    }
    store.removeSession(parentSessionId)
    expect(store.sessions[parentSessionId]).toBeUndefined()
    expect(store.details[active.id]).toBeUndefined()
    expect(store.live[active.id]).toBeUndefined()
  })

  it('keeps parallel live streams separate and merges completed tools', () => {
    const first = summary('subagent:first', 'running')
    const second = summary('subagent:second', 'running')
    const store = useAgentExecutionStore()
    store.upsertSummary(first)
    store.upsertSummary(second)

    store.handleEvent({
      ...eventBase(first, 1),
      type: 'run.status',
      status: 'calling_llm',
    })
    store.handleEvent({
      ...eventBase(second, 1),
      type: 'run.status',
      status: 'calling_llm',
    })
    store.handleEvent({
      ...eventBase(first, 2),
      type: 'assistant.reasoning.delta',
      delta: 'First reasoning',
    })
    store.handleEvent({
      ...eventBase(second, 2),
      type: 'assistant.text.delta',
      delta: 'Discarded output',
    })
    store.handleEvent({
      ...eventBase(second, 3),
      type: 'assistant.stream.reset',
    })
    store.handleEvent({
      ...eventBase(second, 4),
      type: 'provider.retrying',
      retry: { attempt: 2, maxAttempts: 3, delayMs: 250 },
    })
    expect(store.live[second.id]?.providerRetry).toEqual({
      attempt: 2,
      maxAttempts: 3,
      delayMs: 250,
    })
    store.handleEvent({
      ...eventBase(second, 5),
      type: 'assistant.activity',
      activity: 'output',
    })
    expect(store.live[second.id]?.providerRetry).toBeUndefined()
    store.handleEvent({
      ...eventBase(second, 6),
      type: 'assistant.text.delta',
      delta: 'Second output',
    })
    expect(store.live[second.id]?.providerRetry).toBeUndefined()
    store.handleEvent({
      ...eventBase(first, 3),
      type: 'assistant.message.completed',
      text: 'First output',
      reasoning: 'First reasoning',
    })
    store.handleEvent({
      ...eventBase(first, 4),
      type: 'tool.proposed',
      callId: 'call:first-read' as CallId,
      tool: 'read_file',
      args: { path: 'README.md' },
      reason: 'Inspect the file',
    })
    store.handleEvent({
      ...eventBase(first, 5),
      type: 'tool.completed',
      callId: 'call:first-read' as CallId,
      result: { status: 'ok', content: { text: 'done' } },
    })

    expect(store.activitiesFor(first.id)).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        text: 'First reasoning',
      }),
      expect.objectContaining({ type: 'message', text: 'First output' }),
      expect.objectContaining({
        type: 'tool',
        tool: 'read_file',
        status: 'completed',
      }),
    ])
    expect(store.activitiesFor(second.id)).toEqual([
      expect.objectContaining({ type: 'message', text: 'Second output' }),
    ])
    expect(JSON.stringify(store.activitiesFor(second.id))).not.toContain(
      'First reasoning',
    )
  })

  it('projects and decides an approval owned by a child execution', async () => {
    const running = summary('subagent:approval', 'running')
    const decideAgentExecutionApproval = vi.fn(async () =>
      success({ accepted: true }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        decideAgentExecutionApproval,
      } as Partial<AgentApi> as AgentApi,
    })
    const store = useAgentExecutionStore()
    store.upsertSummary(running)
    store.handleEvent({
      ...eventBase(running, 1),
      type: 'approval.requested',
      approval: {
        callId: 'call:child-write' as CallId,
        kind: 'tool',
        tool: 'write_file',
        arguments: { path: 'child.txt' },
        reason: 'Create the delegated output',
        policySignals: [],
        rememberable: false,
        expiresAt: '2026-08-01T00:05:00.000Z',
      },
    })

    expect(store.live[running.id]?.approval).toMatchObject({
      callId: 'call:child-write',
      tool: 'write_file',
    })
    await expect(store.decideApproval(running.id, 'allow')).resolves.toBe(true)
    expect(decideAgentExecutionApproval).toHaveBeenCalledWith({
      version: 1,
      parentSessionId,
      executionId: running.id,
      callId: 'call:child-write',
      decision: 'allow',
    })
    expect(store.live[running.id]?.approval).toBeUndefined()
    expect(store.live[running.id]?.approvalSubmitting).toBe(false)
  })

  it('groups Swarm children under their Job and counts active leaf Agents', () => {
    const root = {
      ...summary('swarm:root', 'running'),
      kind: 'swarm' as const,
      name: 'Swarm review',
      agentCounts: {
        total: 1,
        queued: 1,
        running: 0,
        completed: 0,
        failed: 0,
      },
    }
    const child = {
      ...summary('subagent:swarm-child', 'queued'),
      parentExecutionId: root.id,
      childOrdinal: 1,
      name: 'review',
    }
    const earlierChild = {
      ...summary('subagent:swarm-child-earlier', 'queued'),
      parentExecutionId: root.id,
      childOrdinal: 0,
      name: 'review earlier',
    }
    const store = useAgentExecutionStore()

    store.upsertSummary(root)
    store.upsertSummary(child)
    store.upsertSummary(earlierChild)

    expect(store.selectedExecutions.map((record) => record.id)).toEqual([
      root.id,
    ])
    expect(store.childrenFor(root.id).map((record) => record.id)).toEqual([
      earlierChild.id,
      child.id,
    ])
    expect(store.selectedActiveCount).toBe(2)

    store.handleEvent({
      ...eventBase(child, 1),
      type: 'execution.changed',
      summary: {
        ...child,
        status: 'completed',
        updatedAt: '2026-08-01T00:00:01.000Z',
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    })
    expect(store.selectedActiveCount).toBe(1)
    expect(store.sessions[parentSessionId]?.records).toHaveLength(1)

    store.removeSession(parentSessionId)
    expect(store.children[root.id]).toBeUndefined()
    expect(store.live[child.id]).toBeUndefined()
  })

  it('resynchronizes sequence gaps and refreshes terminal durable state', async () => {
    const running = summary('subagent:gap', 'running')
    const completed = {
      ...running,
      status: 'completed' as const,
      completedAt: timestamp,
    }
    const liveDetail: AgentExecutionDetail = {
      ...detail(running),
      live: {
        schemaVersion: 1,
        status: 'calling_llm',
        text: 'gap output',
        reasoning: 'Recovered reasoning',
        tools: [
          {
            callId: 'call:gap-read' as CallId,
            tool: 'read_file',
            args: { path: 'README.md' },
            reason: '',
            status: 'completed',
            result: { status: 'ok', content: { text: 'recovered' } },
          },
        ],
      },
    }
    const getAgentExecution = vi
      .fn()
      .mockResolvedValueOnce(success({ detail: liveDetail }))
      .mockResolvedValue(success({ detail: detail(completed) }))
    const listAgentExecutions = vi.fn(async () =>
      success({
        page: {
          schemaVersion: 1 as const,
          records: [running],
          hasMore: false as const,
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getAgentExecution,
        listAgentExecutions,
      } as Partial<AgentApi> as AgentApi,
    })
    const store = useAgentExecutionStore()
    store.upsertSummary(running)
    store.handleEvent({
      ...eventBase(running, 1),
      type: 'run.status',
      status: 'calling_llm',
    })
    store.handleEvent({
      ...eventBase(running, 3),
      type: 'assistant.text.delta',
      delta: 'gap output',
    })

    await vi.waitFor(() => {
      expect(listAgentExecutions).toHaveBeenCalledOnce()
      expect(getAgentExecution).toHaveBeenCalledOnce()
      expect(store.details[running.id]?.loaded).toBe(true)
    })
    expect(store.activitiesFor(running.id)).toEqual([
      expect.objectContaining({
        type: 'tool',
        tool: 'read_file',
        status: 'completed',
      }),
      expect.objectContaining({
        type: 'reasoning',
        text: 'Recovered reasoning',
      }),
      expect.objectContaining({ type: 'message', text: 'gap output' }),
    ])
    store.handleEvent({
      ...eventBase(completed, 4),
      type: 'execution.changed',
      summary: completed,
    })
    await vi.waitFor(() => expect(getAgentExecution).toHaveBeenCalledTimes(2))

    expect(store.sessions[parentSessionId]?.records[0]?.status).toBe(
      'completed',
    )
    expect(store.live[running.id]?.text).toBe('')
  })

  it('recovers a missed first event for a Swarm child by parent ownership', async () => {
    const root = {
      ...summary('swarm:resync-root', 'running'),
      kind: 'swarm' as const,
    }
    const child = {
      ...summary('subagent:resync-child', 'running'),
      parentExecutionId: root.id,
    }
    const listAgentExecutions = vi.fn(async () =>
      success({
        page: {
          schemaVersion: 1 as const,
          records: [root],
          hasMore: false as const,
        },
      }),
    )
    const getAgentExecution = vi.fn(async () =>
      success({ detail: detail(child) }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        listAgentExecutions,
        getAgentExecution,
      } as Partial<AgentApi> as AgentApi,
    })
    const store = useAgentExecutionStore()

    store.handleEvent({
      ...eventBase(child, 2),
      type: 'run.status',
      status: 'calling_llm',
    })

    await vi.waitFor(() => expect(store.details[child.id]?.loaded).toBe(true))
    expect(getAgentExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId,
        executionId: child.id,
      }),
    )
    expect(store.childrenFor(root.id)).toEqual([
      expect.objectContaining({ id: child.id }),
    ])
    expect(store.sessions[parentSessionId]?.records).toEqual([
      expect.objectContaining({ id: root.id }),
    ])
  })
})
