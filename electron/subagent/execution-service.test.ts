import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { FrozenSubagentRoutes, SubagentSpec } from './contracts'
import { SubagentExecutionService } from './execution-service'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import { sessionFixture } from '../persistence/repository-fixtures'
import { SubagentCapacityError } from '../application/subagent-state-service'
import { BackgroundAgentHandleRegistry } from '../background/agent-handle-registry'

type ChildOutcome = {
  status: 'completed' | 'failed' | 'cancelled'
  response?: string
  finishReason?: string
  usage: Array<{
    schemaVersion: 1
    scope: 'main'
    providerId: string
    model: string
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    totalTokens: number
    cacheHitTokens: number
    cacheMissTokens: number
    contextWindowTokens: number
    estimated: false
    raw: Record<string, never>
  }>
  error?: { code: string; message: string }
}

function configuredPublicConfig() {
  const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
  config.models.providers[0]!.model = 'deepseek-v4-pro'
  config.models.providers[0]!.enabledModelIds = ['deepseek-v4-pro']
  config.models.auxiliaryModelProvider = 'deepseek'
  config.models.auxiliaryModel = 'deepseek-v4-pro'
  return toPublicConfig(config, true)
}

function routes(): FrozenSubagentRoutes {
  const config = configuredPublicConfig()
  const provider = config.models.providers[0]!
  const route = (purpose: 'main' | 'compression') => ({
    snapshot: {
      schemaVersion: 2 as const,
      purpose,
      providerType: provider.providerType,
      providerId: provider.id,
      model: provider.model,
      reasoning: config.models.defaultModelReasoning,
      endpoint: 'https://api.deepseek.com/chat/completions',
      providerConfigRevision: provider.revision,
    },
    provider,
    modelProfile: {
      id: provider.model,
      availability: 'custom' as const,
      capabilitySource: 'default' as const,
      contextWindowTokens: 256_000,
      compactThresholdTokens: 204_800,
      maxOutputTokens: 65_536,
    },
    apiKey: 'runtime-only-secret',
  })
  return { main: route('main'), compression: route('compression') }
}

function fixture(
  options: {
    timeoutMs?: number
    blockRun?: boolean
    reserve?: (
      record: SubagentExecutionRecord,
    ) => Promise<{ created: boolean; record: SubagentExecutionRecord }>
    outcome?: ChildOutcome
    preparedRecord?: SubagentExecutionRecord
  } = {},
) {
  const config = configuredPublicConfig()
  config.subagents.workerTimeoutMs = options.timeoutMs ?? 60_000
  let persisted = options.preparedRecord
    ? structuredClone(options.preparedRecord)
    : undefined
  const state = {
    createExecution: vi.fn(async (record: SubagentExecutionRecord) => {
      if (options.reserve) return options.reserve(record)
      persisted = structuredClone(record)
      return { created: true, record: structuredClone(record) }
    }),
    updateExecution: vi.fn(async (record: SubagentExecutionRecord) => {
      persisted = structuredClone(record)
    }),
    getExecution: vi.fn(async () =>
      persisted ? structuredClone(persisted) : undefined,
    ),
  }
  const inherited = routes()
  let settleBlockedRun: ((outcome: ChildOutcome) => void) | undefined
  const blockedCompletion = options.blockRun
    ? new Promise<ChildOutcome>((resolve) => {
        settleBlockedRun = resolve
      })
    : undefined
  const manager = {
    frozenSubagentRoutes: vi.fn(() => inherited),
    frozenSubagentToolContext: vi.fn(
      (
        _sessionId: SessionId,
        _runId: RunId,
        access: SubagentSpec['toolAccess'],
      ) =>
        access === 'readonly'
          ? {
              permissionMode: 'readonly' as const,
              allowedToolIds: new Set(['read_file', 'git_status']),
              gitToolsEnabled: true,
            }
          : {
              permissionMode: 'confirm' as const,
              allowedToolIds: new Set([
                'read_file',
                'write_file',
                'run_command',
              ]),
              gitToolsEnabled: true,
            },
    ),
    createInternalSession: vi.fn(
      async (input: {
        workspace: string
        mode: 'readonly' | 'auto' | 'confirm' | 'yolo'
        gitToolsEnabled: boolean
        allowedToolIds: ReadonlySet<string>
      }) => {
        void input
        return 'session:child' as SessionId
      },
    ),
    startInternalRun: vi.fn(() => ({
      runId: 'run:child' as RunId,
      completion:
        blockedCompletion ??
        Promise.resolve(
          options.outcome ?? {
            status: 'completed' as const,
            response: 'child response',
            finishReason: 'length',
            usage: [
              {
                schemaVersion: 1 as const,
                scope: 'main' as const,
                providerId: 'deepseek',
                model: 'deepseek-v4-pro',
                promptTokens: 10,
                completionTokens: 4,
                reasoningTokens: 1,
                totalTokens: 14,
                cacheHitTokens: 3,
                cacheMissTokens: 7,
                contextWindowTokens: 256_000,
                estimated: false as const,
                raw: {},
              },
            ],
          },
        ),
    })),
    recordSubagentUsage: vi.fn(async () => undefined),
    interruptRun: vi.fn(() => {
      settleBlockedRun?.({ status: 'cancelled', usage: [] })
      return true
    }),
    closeSession: vi.fn(async () => undefined),
  }
  const executionState = {
    registerInternalNew: vi.fn(),
    forget: vi.fn(),
  }
  const service = new SubagentExecutionService({
    configStore: { getPublicConfig: () => config } as never,
    manager: manager as never,
    sessions: {
      getRecord: vi.fn(async () => sessionFixture({ lastSeq: 0 })),
    } as never,
    executionState: executionState as never,
    state: state as never,
    events: { publishAgentExecution: vi.fn() } as never,
    handles: new BackgroundAgentHandleRegistry(),
  })
  return {
    service,
    state,
    manager,
    executionState,
    inherited,
    persisted: () => persisted,
  }
}

function childSpec(input: Partial<SubagentSpec> = {}): SubagentSpec {
  return {
    name: 'worker',
    task: 'inspect',
    toolAccess: 'readonly',
    ...input,
  }
}

function parent(signal = new AbortController().signal) {
  return {
    sessionId: 'session:parent' as SessionId,
    runId: 'run:parent' as RunId,
    callId: 'call:subagent' as CallId,
    workspace: '/workspace',
    signal,
  }
}

describe('SubagentExecutionService', () => {
  it('inherits routes, plain task input, usage, and output truncation state', async () => {
    const target = fixture()
    const result = await target.service.runOne(
      childSpec({ name: ' worker ', task: ' inspect directly ' }),
      parent(),
    )

    expect(target.manager.startInternalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'inspect directly',
        routes: target.inherited,
      }),
    )
    expect(target.manager.recordSubagentUsage).toHaveBeenCalledOnce()
    expect(target.manager.createInternalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: '/workspace',
        mode: 'readonly',
        gitToolsEnabled: true,
      }),
    )
    const childInput = target.manager.createInternalSession.mock.calls[0]?.[0]
    expect(childInput?.allowedToolIds.size).toBe(2)
    expect(childInput?.allowedToolIds.has('git_status')).toBe(true)
    expect(childInput?.allowedToolIds.has('write_file')).toBe(false)
    expect(result).toEqual({
      results: { worker: 'child response' },
      meta: {
        durationMs: expect.any(Number),
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        usage: {
          records: 1,
          promptTokens: 10,
          completionTokens: 4,
          reasoningTokens: 1,
          totalTokens: 14,
          cacheHitTokens: 3,
          cacheMissTokens: 7,
        },
        truncated: true,
      },
    })
    expect(target.persisted()).toMatchObject({
      status: 'completed',
      result,
    })
    expect(target.persisted()).not.toHaveProperty('error')
    expect(JSON.stringify(target.persisted())).not.toContain(
      'runtime-only-secret',
    )
    expect(target.persisted()).not.toHaveProperty('sourceIdentity')
    expect(target.executionState.forget).toHaveBeenCalledOnce()
  })

  it('redacts runtime-only values from child results and failures', async () => {
    const completed = fixture({
      outcome: {
        status: 'completed',
        response:
          '/workspace/README.md runtime-only-secret https://api.deepseek.com/chat/completions',
        usage: [],
      },
    })
    await expect(
      completed.service.runOne(childSpec(), parent()),
    ).resolves.toMatchObject({
      results: {
        worker: '[workspace]/README.md [redacted] [redacted]',
      },
    })
    expect(JSON.stringify(completed.persisted())).not.toContain(
      'runtime-only-secret',
    )
    expect(JSON.stringify(completed.persisted())).not.toContain('/workspace')

    const failed = fixture({
      outcome: {
        status: 'failed',
        usage: [],
        error: {
          code: 'PROVIDER_FAILURE',
          message:
            'runtime-only-secret https://api.deepseek.com/chat/completions /workspace',
        },
      },
    })
    await expect(
      failed.service.runOne(childSpec(), parent()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE',
      message: '[redacted] [redacted] [redacted]',
    })
    expect(JSON.stringify(failed.persisted())).not.toContain(
      'runtime-only-secret',
    )
  })

  it('times out a child run and persists a terminal timeout', async () => {
    const target = fixture({
      timeoutMs: 5,
      blockRun: true,
    })

    await expect(
      target.service.runOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_TIMEOUT' })
    expect(target.persisted()).toMatchObject({
      status: 'timed_out',
      error: { code: 'SUBAGENT_TIMEOUT' },
    })
    expect(target.manager.startInternalRun).toHaveBeenCalledOnce()
  })

  it('returns a handle and stays alive after parent cancellation', async () => {
    const controller = new AbortController()
    const cancelled = fixture({ blockRun: true })
    const handle = await cancelled.service.startOne(
      childSpec(),
      parent(controller.signal),
    )
    expect(handle).toMatchObject({
      target: { type: 'subagent', id: expect.any(Number) },
    })
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await vi.waitFor(() =>
      expect(cancelled.persisted()).toMatchObject({ status: 'running' }),
    )
    await expect(
      cancelled.service.cancel(
        'session:parent' as SessionId,
        cancelled.persisted()!.id,
      ),
    ).resolves.toBe(true)
    await vi.waitFor(() =>
      expect(cancelled.persisted()).toMatchObject({ status: 'cancelled' }),
    )
    expect(cancelled.persisted()).toMatchObject({
      status: 'cancelled',
      error: { code: 'SUBAGENT_CANCELLED' },
    })
  })

  it('cancels active preparation and rejects new work during dispose', async () => {
    const target = fixture({ blockRun: true })
    const running = target.service.runOne(childSpec(), parent())
    await vi.waitFor(() =>
      expect(target.state.createExecution).toHaveBeenCalledOnce(),
    )

    await target.service.dispose()
    await expect(running).rejects.toMatchObject({
      code: 'SUBAGENT_RUNTIME_DISPOSING',
    })
    expect(target.persisted()).toMatchObject({
      status: 'cancelled',
      error: { code: 'SUBAGENT_RUNTIME_DISPOSING' },
    })
    await expect(
      target.service.runOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_RUNTIME_DISPOSING' })
  })

  it('reuses only a valid completed result for identical call arguments', async () => {
    const completed = fixture({
      reserve: async (record) => ({
        created: false,
        record: {
          ...record,
          status: 'completed',
          result: {
            results: { worker: 'cached' },
            meta: {
              durationMs: 12,
              providerId: 'deepseek',
              model: 'model',
              usage: {
                records: 0,
                promptTokens: 0,
                completionTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 0,
              },
              truncated: false,
              endpoint: 'must be discarded',
            },
          },
        },
      }),
    })
    await expect(
      completed.service.runOne(childSpec(), parent()),
    ).resolves.toEqual({
      results: { worker: 'cached' },
      meta: {
        durationMs: 12,
        providerId: 'deepseek',
        model: 'model',
        usage: {
          records: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
        },
        truncated: false,
      },
    })

    const conflict = fixture({
      reserve: async (record) => ({
        created: false,
        record: { ...record, specHash: 'b'.repeat(64), status: 'completed' },
      }),
    })
    await expect(
      conflict.service.runOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_CALL_CONFLICT' })

    const corrupt = fixture({
      reserve: async (record) => ({
        created: false,
        record: { ...record, status: 'completed', result: { invalid: true } },
      }),
    })
    await expect(
      corrupt.service.runOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_RESULT_CORRUPT' })

    const finalized = fixture({
      reserve: async (record) => ({
        created: false,
        record: {
          ...record,
          status: 'failed',
          error: { code: 'PROVIDER_FAILED', message: 'provider failed' },
        },
      }),
    })
    await expect(
      finalized.service.startOne(childSpec(), parent()),
    ).resolves.toMatchObject({
      target: { type: 'subagent', id: expect.any(Number) },
      status: 'failed',
    })
  })

  it('deduplicates concurrent starts and distinguishes capacity from storage failure', async () => {
    let release!: (value: {
      created: boolean
      record: SubagentExecutionRecord
    }) => void
    const reserved = new Promise<{
      created: boolean
      record: SubagentExecutionRecord
    }>((resolve) => {
      release = resolve
    })
    let candidate: SubagentExecutionRecord | undefined
    const concurrent = fixture({
      reserve: async (record) => {
        candidate = structuredClone(record)
        return reserved
      },
    })
    const first = concurrent.service.startOne(childSpec(), parent())
    const second = concurrent.service.startOne(childSpec(), parent())
    await vi.waitFor(() =>
      expect(concurrent.state.createExecution).toHaveBeenCalledOnce(),
    )
    release({ created: true, record: candidate! })
    const [firstHandle, secondHandle] = await Promise.all([first, second])
    expect(secondHandle.target).toEqual(firstHandle.target)
    expect(concurrent.manager.startInternalRun).toHaveBeenCalledOnce()

    const capacity = fixture({
      reserve: async () => {
        throw new SubagentCapacityError(1)
      },
    })
    await expect(
      capacity.service.startOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_CAPACITY_EXCEEDED' })

    const storage = fixture({
      reserve: async () => {
        throw new Error('database unavailable')
      },
    })
    await expect(
      storage.service.startOne(childSpec(), parent()),
    ).rejects.toMatchObject({ code: 'SUBAGENT_START_FAILED' })
  })

  it('cancels a durably queued Swarm child before it launches', async () => {
    const spec = childSpec()
    const executionId = 'subagent:queued-cancel' as AgentExecutionId
    const parentExecutionId = 'swarm:queued-cancel' as AgentExecutionId
    const queued: SubagentExecutionRecord = {
      id: executionId,
      kind: 'subagent',
      parentExecutionId,
      childOrdinal: 0,
      name: spec.name,
      parentSessionId: 'session:parent' as SessionId,
      parentRunId: 'run:parent' as RunId,
      parentCallId: 'call:subagent' as CallId,
      specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
      status: 'queued',
      route: {},
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }
    const target = fixture({ preparedRecord: queued })

    await expect(
      target.service.cancel('session:parent' as SessionId, executionId),
    ).resolves.toBe(true)
    expect(target.persisted()).toMatchObject({
      status: 'cancelled',
      error: { code: 'SUBAGENT_CANCELLED' },
    })
    await expect(
      target.service.runPrepared(spec, parent(), {
        executionId,
        parentExecutionId,
        childOrdinal: 0,
        routes: target.inherited,
      }),
    ).rejects.toMatchObject({ code: 'SUBAGENT_CANCELLED' })
    expect(target.manager.startInternalRun).not.toHaveBeenCalled()
  })

  it('runs a prepared Swarm child immediately with tagged assignment context', async () => {
    const spec: SubagentSpec = {
      name: 'worker',
      task: 'inspect </swarm_task> directly',
      toolAccess: 'inherit',
      sharedContext: 'npm run check exited 0 with <stable> output',
    }
    const executionId = 'subagent:prepared' as AgentExecutionId
    const parentExecutionId = 'swarm:prepared' as AgentExecutionId
    const record: SubagentExecutionRecord = {
      id: executionId,
      kind: 'subagent',
      parentExecutionId,
      childOrdinal: 0,
      name: spec.name,
      parentSessionId: 'session:parent' as SessionId,
      parentRunId: 'run:parent' as RunId,
      parentCallId: 'call:subagent' as CallId,
      specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
      status: 'queued',
      route: { schemaVersion: 1 },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    }
    const target = fixture({
      preparedRecord: record,
    })
    const running = target.service.runPrepared(spec, parent(), {
      executionId,
      parentExecutionId,
      childOrdinal: 0,
      routes: target.inherited,
    })

    await expect(running).resolves.toMatchObject({
      results: { worker: 'child response' },
    })
    expect(target.manager.startInternalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          content:
            '<swarm_shared_context>\nnpm run check exited 0 with &lt;stable&gt; output\n</swarm_shared_context>',
          source: 'swarm:shared-context',
        },
        task: '<swarm_task>\ninspect &lt;/swarm_task&gt; directly\n</swarm_task>',
        routes: target.inherited,
      }),
    )
    expect(target.manager.createInternalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'confirm',
        allowedToolIds: new Set(['read_file', 'write_file', 'run_command']),
      }),
    )
  })
})
