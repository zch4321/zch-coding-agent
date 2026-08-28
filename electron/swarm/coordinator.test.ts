import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { SwarmRunArgs } from '../../shared/swarm'
import type { ConfigStore } from '../config/store'
import type { PreparedModelPoolPlan } from '../model-pool/freezer'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type { SessionManager } from '../session/session-manager'
import type {
  PreparedSubagentExecution,
  PreparedSubagentExecutionPort,
  SubagentRunResult,
  SubagentSpec,
} from '../subagent/contracts'
import {
  SubagentCapacityError,
  type SubagentStateService,
} from '../application/subagent-state-service'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { SwarmParentContext } from './contracts'

const { freezeModelPoolPlanMock } = vi.hoisted(() => ({
  freezeModelPoolPlanMock: vi.fn(),
}))

vi.mock('../model-pool/freezer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../model-pool/freezer')>()),
  freezeModelPoolPlan: freezeModelPoolPlanMock,
}))

import { SwarmCoordinator } from './coordinator'

const sessionId = 'session:swarm-test' as SessionId
const runId = 'run:swarm-test' as RunId

function usage(totalTokens = 1) {
  return {
    records: 1,
    promptTokens: totalTokens,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    cacheHitTokens: 0,
    cacheMissTokens: totalTokens,
  }
}

function completed(spec: SubagentSpec): SubagentRunResult {
  return {
    results: { [spec.name]: `result:${spec.name}` },
    meta: {
      durationMs: 10,
      providerId: 'provider-a',
      model: 'model-a',
      usage: usage(),
      truncated: false,
    },
  }
}

function plan(count: number): PreparedModelPoolPlan {
  const assignments = Array.from({ length: count }, (_, requirementIndex) => ({
    requirementIndex,
    requestedCapability: 'standard' as const,
    entryId: `entry-${requirementIndex}`,
    providerId: 'provider-a',
    model: 'model-a',
    reasoning: 'medium' as const,
    capability: 'standard' as const,
    routes: {
      main: {
        apiKey: 'secret',
        provider: {},
        modelProfile: {},
        snapshot: {
          schemaVersion: 2,
          purpose: 'main',
          providerId: 'provider-a',
          providerType: 'openai_compatible',
          providerConfigRevision: 1,
          endpoint: 'https://example.invalid',
          model: 'model-a',
          reasoning: 'medium',
        },
      },
      compression: {
        apiKey: 'secret',
        provider: {},
        modelProfile: {},
        snapshot: {
          schemaVersion: 2,
          purpose: 'compression',
          providerId: 'provider-a',
          providerType: 'openai_compatible',
          providerConfigRevision: 1,
          endpoint: 'https://example.invalid',
          model: 'model-a',
          reasoning: 'medium',
        },
      },
    },
  })) as unknown as PreparedModelPoolPlan['assignments']
  return {
    assignments,
    safeSnapshot: {
      schemaVersion: 2,
      poolDigest: 'a'.repeat(64),
      assignments: [],
    },
  }
}

function args(agentCount = 2): SwarmRunArgs {
  return {
    sharedContext: 'npm run check exited 0. Review the current repository.',
    tasks: [
      {
        name: 'review',
        task: 'Review the implementation.',
        requiredCapability: 'standard',
        agentCount,
        toolAccess: 'readonly',
      },
    ],
  }
}

function parent(callId: string): SwarmParentContext {
  return {
    sessionId,
    runId,
    callId: callId as CallId,
    workspace: 'F:\\workspace\\fixture',
    signal: new AbortController().signal,
  }
}

function fixture(
  runPrepared: PreparedSubagentExecutionPort['runPrepared'],
  options: {
    createSwarmJob?: (
      root: SubagentExecutionRecord,
      children: SubagentExecutionRecord[],
    ) => Promise<{
      created: boolean
      root: SubagentExecutionRecord
      children?: SubagentExecutionRecord[]
    }>
  } = {},
) {
  const records = new Map<AgentExecutionId, SubagentExecutionRecord>()
  const roots = new Map<string, SubagentExecutionRecord>()
  const state = {
    async getRootExecution(input: { parentCallId: CallId }) {
      return roots.get(input.parentCallId)
    },
    async createSwarmJob(
      root: SubagentExecutionRecord,
      children: SubagentExecutionRecord[],
    ) {
      if (options.createSwarmJob) {
        return options.createSwarmJob(root, children)
      }
      const existing = roots.get(root.parentCallId)
      if (existing) return { created: false as const, root: existing }
      roots.set(root.parentCallId, root)
      records.set(root.id, root)
      for (const child of children) records.set(child.id, child)
      return { created: true as const, root }
    },
    async updateExecution(record: SubagentExecutionRecord) {
      records.set(record.id, record)
    },
    async getExecution(_parentSessionId: SessionId, id: AgentExecutionId) {
      return records.get(id)
    },
    async executionCounts(rootExecutionId: AgentExecutionId) {
      const children = [...records.values()].filter(
        (record) => record.parentExecutionId === rootExecutionId,
      )
      return {
        total: children.length,
        queued: children.filter(
          (record) =>
            record.status === 'queued' || record.status === 'preparing',
        ).length,
        running: children.filter((record) => record.status === 'running')
          .length,
        completed: children.filter((record) => record.status === 'completed')
          .length,
        failed: children.filter((record) =>
          ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(
            record.status,
          ),
        ).length,
      }
    },
    async listChildren(
      _parentSessionId: SessionId,
      rootExecutionId: AgentExecutionId,
    ) {
      return [...records.values()]
        .filter((record) => record.parentExecutionId === rootExecutionId)
        .sort(
          (left, right) => (left.childOrdinal ?? 0) - (right.childOrdinal ?? 0),
        )
    },
  }
  const publishAgentExecution = vi.fn()
  const coordinator = new SwarmCoordinator({
    configStore: {
      getPublicConfig: () => ({}),
    } as ConfigStore,
    manager: {
      frozenSwarmContext: () => ({
        goal: 'Review the project',
      }),
      frozenSubagentToolContext: () => ({
        permissionMode: 'readonly',
        allowedToolIds: new Set<string>(),
        gitToolsEnabled: true,
      }),
    } as unknown as SessionManager,
    state: state as unknown as SubagentStateService,
    subagents: {
      runOne: vi.fn(),
      runPrepared,
    },
    events: { publishAgentExecution } as unknown as RuntimeEventSink,
  })
  return { coordinator, records, roots, publishAgentExecution }
}

describe('SwarmCoordinator', () => {
  beforeEach(() => {
    freezeModelPoolPlanMock.mockReset()
  })

  it('rejects blank shared context before freezing model assignments', async () => {
    const { coordinator } = fixture(vi.fn())

    await expect(
      coordinator.run(
        { ...args(1), sharedContext: '   ' },
        parent('call:blank-context'),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SWARM_SHARED_CONTEXT' })
    expect(freezeModelPoolPlanMock).not.toHaveBeenCalled()
  })

  it('returns replicas individually in declaration order despite completion order', async () => {
    const releases: Array<() => void> = []
    const calls: PreparedSubagentExecution[] = []
    const specs: SubagentSpec[] = []
    const runPrepared = vi.fn(
      async (
        spec: SubagentSpec,
        _parent: SwarmParentContext,
        prepared: PreparedSubagentExecution,
      ) =>
        new Promise<SubagentRunResult>((resolve) => {
          calls.push(prepared)
          specs.push(spec)
          releases.push(() => resolve(completed(spec)))
        }),
    )
    freezeModelPoolPlanMock.mockResolvedValue(plan(3))
    const { coordinator } = fixture(runPrepared)
    const pending = coordinator.run(
      {
        sharedContext: args(2).sharedContext,
        tasks: [
          ...args(2).tasks,
          {
            name: 'tests',
            task: 'Review the tests.',
            requiredCapability: 'standard',
            agentCount: 1,
            toolAccess: 'readonly',
          },
        ],
      },
      parent('call:ordered'),
    )

    await vi.waitFor(() => expect(calls).toHaveLength(3))
    releases[2]!()
    releases[0]!()
    releases[1]!()
    const result = await pending

    expect(result.results.map((entry) => entry.name)).toEqual([
      'review · 1/2',
      'review · 2/2',
      'tests',
    ])
    expect(specs.map((spec) => spec.sharedContext)).toEqual(
      Array(3).fill('npm run check exited 0. Review the current repository.'),
    )
    expect(result.meta).toMatchObject({
      status: 'completed',
      agentCount: 3,
      completedCount: 3,
      failedCount: 0,
    })
  })

  it('returns a partial result without hiding a failed replica', async () => {
    freezeModelPoolPlanMock.mockResolvedValue(plan(2))
    let invocation = 0
    const durableRecords: {
      current?: Map<AgentExecutionId, SubagentExecutionRecord>
    } = {}
    const runPrepared = vi.fn(
      async (
        spec: SubagentSpec,
        _parent: SwarmParentContext,
        prepared: PreparedSubagentExecution,
      ) => {
        invocation += 1
        if (invocation === 1) return completed(spec)
        const record = durableRecords.current!.get(prepared.executionId)!
        record.status = 'failed'
        record.error = { code: 'WORKER_FAILED', message: 'worker failed' }
        throw new Error('worker failed')
      },
    )
    const fixtureValue = fixture(runPrepared)
    durableRecords.current = fixtureValue.records

    const result = await fixtureValue.coordinator.run(
      args(2),
      parent('call:partial'),
    )

    expect(result.meta).toMatchObject({
      status: 'partial',
      completedCount: 1,
      failedCount: 1,
    })
    expect(result.results[1]).toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_FAILED' },
    })
  })

  it('bounds successful and failed replica text without dropping entries', async () => {
    freezeModelPoolPlanMock.mockResolvedValue(plan(32))
    const durableRecords: {
      current?: Map<AgentExecutionId, SubagentExecutionRecord>
    } = {}
    let invocation = 0
    const longFailure = '失败'.repeat(32_768)
    const runPrepared = vi.fn(
      async (
        spec: SubagentSpec,
        _parent: SwarmParentContext,
        prepared: PreparedSubagentExecution,
      ) => {
        invocation += 1
        if (invocation === 1) {
          const result = completed(spec)
          result.results[spec.name] = 'success'.repeat(300_000)
          return result
        }
        const record = durableRecords.current!.get(prepared.executionId)!
        record.status = 'failed'
        record.error = { code: 'WORKER_FAILED', message: longFailure }
        throw new Error(longFailure)
      },
    )
    const fixtureValue = fixture(runPrepared)
    durableRecords.current = fixtureValue.records

    const result = await fixtureValue.coordinator.run(
      args(32),
      parent('call:bounded'),
    )

    expect(result.results).toHaveLength(32)
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(2_000_000)
    expect(result.results.every((entry) => entry.truncated)).toBe(true)
    expect(result.results[1]?.error?.message).not.toBe(longFailure)
  })

  it('runs multiple Jobs owned by the same parent Run concurrently', async () => {
    freezeModelPoolPlanMock.mockImplementation(async (_store, requirements) =>
      plan((requirements as unknown[]).length),
    )
    let releaseFirst!: () => void
    const runPrepared = vi
      .fn()
      .mockImplementationOnce(
        async (spec: SubagentSpec) =>
          new Promise<SubagentRunResult>((resolve) => {
            releaseFirst = () => resolve(completed(spec))
          }),
      )
      .mockImplementation(async (spec: SubagentSpec) => completed(spec))
    const { coordinator } = fixture(runPrepared)

    const first = coordinator.run(args(1), parent('call:first-job'))
    await vi.waitFor(() => expect(runPrepared).toHaveBeenCalledTimes(1))
    const second = coordinator.run(args(1), parent('call:second-job'))
    await vi.waitFor(() => expect(runPrepared).toHaveBeenCalledTimes(2))
    expect(freezeModelPoolPlanMock).toHaveBeenCalledTimes(2)

    await expect(second).resolves.toMatchObject({
      meta: { status: 'completed' },
    })

    releaseFirst()
    await expect(first).resolves.toMatchObject({
      meta: { status: 'completed' },
    })
  })

  it('fails the Job when every child Agent fails', async () => {
    freezeModelPoolPlanMock.mockResolvedValue(plan(2))
    const durableRecords: {
      current?: Map<AgentExecutionId, SubagentExecutionRecord>
    } = {}
    const runPrepared = vi.fn(
      async (
        _spec: SubagentSpec,
        _parent: SwarmParentContext,
        prepared: PreparedSubagentExecution,
      ) => {
        const record = durableRecords.current!.get(prepared.executionId)!
        record.status = 'failed'
        record.error = { code: 'WORKER_FAILED', message: 'worker failed' }
        throw new Error('worker failed')
      },
    )
    const fixtureValue = fixture(runPrepared)
    durableRecords.current = fixtureValue.records

    await expect(
      fixtureValue.coordinator.run(args(2), parent('call:all-fail')),
    ).rejects.toMatchObject({ code: 'SWARM_ALL_AGENTS_FAILED' })
    expect(fixtureValue.roots.get('call:all-fail')?.status).toBe('failed')
    await expect(
      fixtureValue.coordinator.start(args(2), parent('call:all-fail')),
    ).resolves.toMatchObject({
      target: { type: 'swarm', id: expect.any(String) },
      status: 'failed',
    })
  })

  it('distinguishes atomic capacity rejection from durable storage failure', async () => {
    freezeModelPoolPlanMock.mockResolvedValue(plan(1))
    const capacity = fixture(vi.fn(), {
      createSwarmJob: async () => {
        throw new SubagentCapacityError(1)
      },
    })
    await expect(
      capacity.coordinator.start(args(1), parent('call:capacity')),
    ).rejects.toMatchObject({ code: 'SUBAGENT_CAPACITY_EXCEEDED' })

    const storage = fixture(vi.fn(), {
      createSwarmJob: async () => {
        throw new Error('database unavailable')
      },
    })
    await expect(
      storage.coordinator.start(args(1), parent('call:storage')),
    ).rejects.toMatchObject({ code: 'SWARM_START_FAILED' })
  })

  it('preserves task and assignment metadata after manifest status updates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-manifest-'))
    const sessionTemp = {
      root,
      artifacts: path.join(root, 'artifacts'),
      scratch: path.join(root, 'scratch'),
    }
    freezeModelPoolPlanMock.mockResolvedValue(plan(1))
    const durableRecords: {
      current?: Map<AgentExecutionId, SubagentExecutionRecord>
    } = {}
    const fixtureValue = fixture(async (spec, _parent, prepared) => {
      const record = durableRecords.current!.get(prepared.executionId)!
      record.status = 'completed'
      record.updatedAt = new Date().toISOString()
      record.completedAt = record.updatedAt
      return completed(spec)
    })
    durableRecords.current = fixtureValue.records

    try {
      await fixtureValue.coordinator.run(args(1), {
        ...parent('call:manifest'),
        sessionTemp,
      })
      const execution = fixtureValue.roots.get('call:manifest')!
      const manifest = JSON.parse(
        await readFile(
          path.join(
            sessionTemp.artifacts,
            'swarms',
            execution!.id,
            'manifest.json',
          ),
          'utf8',
        ),
      ) as Record<string, unknown>

      expect(manifest).toMatchObject({
        status: 'completed',
        sharedContext: args(1).sharedContext,
        tasks: args(1).tasks,
        children: [
          {
            taskIndex: 0,
            agentIndex: 1,
            status: 'completed',
            assignment: {
              providerId: 'provider-a',
              model: 'model-a',
            },
          },
        ],
      })
    } finally {
      await fixtureValue.coordinator.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
