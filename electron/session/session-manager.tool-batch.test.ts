import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Type } from '@sinclair/typebox'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
import type { PermissionMode } from '../../shared/config'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
} from '../providers/provider-test-harness'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'
import { SessionManager } from './session-manager'
import type {
  SubagentExecutionPort,
  SubagentRunResult,
} from '../subagent/contracts'
import { PluginEventBus } from '../plugins/event-bus'
import type {
  ToolDefinition,
  ToolExecutionMode,
  ToolResult,
} from '../tools/types'

interface BatchCall {
  id: string
  toolId: string
  args: JsonObject
}

const EmptyArgsSchema = Type.Object({}, { additionalProperties: false })

function fixtureTool(
  id: string,
  executionMode: ToolExecutionMode | undefined,
  execute: () => Promise<ToolResult>,
): ToolDefinition<typeof EmptyArgsSchema> {
  return {
    id,
    ...(executionMode ? { executionMode } : {}),
    description: `Test scheduler tool ${id}`,
    inputSchema: EmptyArgsSchema,
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 4_096,
    execute,
  }
}

class BatchProvider extends ScriptedProviderHarness {
  calls = 0
  readonly #batch: BatchCall[]

  constructor(batch: BatchCall[]) {
    super()
    this.#batch = batch
  }

  async *run(): AsyncIterable<ScriptedProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'batch' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: this.#batch.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.toolId,
              arguments: JSON.stringify(call.args),
            },
          })),
        },
        toolCalls: this.#batch.map((call) => ({
          id: call.id as CallId,
          toolId: call.toolId,
          args: call.args,
          reason: 'batch fixture',
        })),
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'done' },
      turn: { role: 'assistant', content: 'Batch handled' },
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

function subagentResult(name = 'worker'): SubagentRunResult {
  return {
    results: { [name]: 'delegated result' },
    meta: {
      durationMs: 1,
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
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
  }
}

interface BatchFixtureOptions {
  mode?: PermissionMode
  runOne?: SubagentExecutionPort['runOne']
  tools?: ToolDefinition[]
  onStarted?(input: {
    manager: SessionManager
    sessionId: Awaited<ReturnType<SessionManager['createSession']>>
    runId: ReturnType<SessionManager['startRun']>
    events: AgentEventEnvelope[]
  }): Promise<void>
}

async function fixture(batch: BatchCall[], options: BatchFixtureOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-tool-batch-'))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'README.md'), 'batch fixture\n', 'utf8')
  const configStore = await createConfig(directory)
  await configStore.update({
    version: 1,
    kind: 'subagents',
    value: { enabled: true, workerTimeoutMs: 60_000 },
  })
  const events: AgentEventEnvelope[] = []
  const runOne = vi.fn(
    options.runOne ?? (async (spec) => subagentResult(spec.name)),
  )
  const provider = new BatchProvider(batch)
  const pluginBus = options.tools ? new PluginEventBus() : undefined
  const manager = new SessionManager({
    configStore,
    traceDirectory: path.join(directory, 'traces'),
    eventSink: createIpcTestEventSink((event) => events.push(event)),
    providerFactory: () => provider,
    subagentExecution: { runOne },
    pluginBus,
  })
  for (const tool of options.tools ?? []) pluginBus?.registerTool(tool)
  const sessionId = await manager.createSession({
    workspace,
    mode: options.mode ?? 'readonly',
    provider: 'deepseek',
  })
  const runId = manager.startRun({
    sessionId,
    message: 'Run the batch',
    clientRequestId: 'request:batch',
  })
  await options.onStarted?.({ manager, sessionId, runId, events })
  await waitFor(() =>
    events.some(
      ({ event }) =>
        event.type === 'run.status' &&
        event.runId === runId &&
        event.status === 'completed',
    ),
  )
  return { manager, sessionId, runId, events, provider, runOne }
}

describe('Session Tool batch scheduling', () => {
  it('allows subagent_run anywhere in a parallel segment', async () => {
    const result = await fixture([
      {
        id: 'call:subagent',
        toolId: 'subagent_run',
        args: { name: 'worker', task: 'Inspect README directly.' },
      },
      { id: 'call:read', toolId: 'read_file', args: { path: 'README.md' } },
    ])
    try {
      expect(result.runOne).toHaveBeenCalledOnce()
      const completed = result.events.filter(
        ({ event }) =>
          event.type === 'tool.completed' && event.runId === result.runId,
      )
      expect(completed).toHaveLength(2)
      expect(
        completed.every(
          ({ event }) =>
            event.type === 'tool.completed' && event.result.status === 'ok',
        ),
      ).toBe(true)
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })

  it('runs repeated subagent calls concurrently and finalizes in call order', async () => {
    let active = 0
    let maximumActive = 0
    let started = 0
    let releaseBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const runOne: SubagentExecutionPort['runOne'] = async (spec) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      started += 1
      if (started === 2) releaseBoth()
      await bothStarted
      active -= 1
      return subagentResult(spec.name)
    }
    const result = await fixture(
      [
        { id: 'call:read', toolId: 'read_file', args: { path: 'README.md' } },
        {
          id: 'call:subagent-1',
          toolId: 'subagent_run',
          args: { name: 'first', task: 'Inspect first.' },
        },
        {
          id: 'call:subagent-2',
          toolId: 'subagent_run',
          args: { name: 'second', task: 'Inspect second.' },
        },
      ],
      { runOne },
    )
    try {
      expect(result.runOne).toHaveBeenCalledTimes(2)
      expect(maximumActive).toBe(2)
      const completed = result.events.filter(
        ({ event }) =>
          event.type === 'tool.completed' && event.runId === result.runId,
      )
      expect(completed).toHaveLength(3)
      expect(
        completed.map(({ event }) =>
          event.type === 'tool.completed' ? event.callId : undefined,
        ),
      ).toEqual(['call:read', 'call:subagent-1', 'call:subagent-2'])
      expect(
        completed.every(
          ({ event }) =>
            event.type === 'tool.completed' && event.result.status === 'ok',
        ),
      ).toBe(true)
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })

  it('uses serial tools as barriers between parallel segments', async () => {
    let parallelStarted = 0
    let parallelFinished = 0
    let parallelActive = 0
    let maximumParallelActive = 0
    let serialStarted = false
    let afterStarted = false
    let releaseParallel!: () => void
    let releaseSerial!: () => void
    const parallelGate = new Promise<void>((resolve) => {
      releaseParallel = resolve
    })
    const serialGate = new Promise<void>((resolve) => {
      releaseSerial = resolve
    })
    const parallelTool = (id: string) =>
      fixtureTool(id, 'parallel', async () => {
        parallelStarted += 1
        parallelActive += 1
        maximumParallelActive = Math.max(maximumParallelActive, parallelActive)
        await parallelGate
        parallelActive -= 1
        parallelFinished += 1
        return { status: 'ok', content: { id } }
      })
    const tools = [
      parallelTool('parallel_first'),
      parallelTool('parallel_second'),
      fixtureTool('serial_barrier', 'serial', async () => {
        serialStarted = true
        await serialGate
        return { status: 'ok', content: { id: 'serial_barrier' } }
      }),
      fixtureTool('parallel_after', 'parallel', async () => {
        afterStarted = true
        return { status: 'ok', content: { id: 'parallel_after' } }
      }),
    ]
    const result = await fixture(
      [
        { id: 'call:first', toolId: 'parallel_first', args: {} },
        { id: 'call:second', toolId: 'parallel_second', args: {} },
        { id: 'call:serial', toolId: 'serial_barrier', args: {} },
        { id: 'call:after', toolId: 'parallel_after', args: {} },
      ],
      {
        tools,
        async onStarted() {
          await waitFor(() => parallelStarted === 2)
          expect(maximumParallelActive).toBe(2)
          expect(serialStarted).toBe(false)
          releaseParallel()
          await waitFor(() => serialStarted)
          expect(parallelFinished).toBe(2)
          expect(afterStarted).toBe(false)
          releaseSerial()
        },
      },
    )
    try {
      expect(afterStarted).toBe(true)
      const completed = result.events.filter(
        ({ event }) =>
          event.type === 'tool.completed' && event.runId === result.runId,
      )
      expect(
        completed.map(({ event }) =>
          event.type === 'tool.completed' ? event.callId : undefined,
        ),
      ).toEqual(['call:first', 'call:second', 'call:serial', 'call:after'])
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })

  it('defaults tools without an execution mode to serial', async () => {
    let active = 0
    let maximumActive = 0
    const execute = async (): Promise<ToolResult> => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { status: 'ok', content: {} }
    }
    const result = await fixture(
      [
        { id: 'call:default-1', toolId: 'default_serial_1', args: {} },
        { id: 'call:default-2', toolId: 'default_serial_2', args: {} },
      ],
      {
        tools: [
          fixtureTool('default_serial_1', undefined, execute),
          fixtureTool('default_serial_2', undefined, execute),
        ],
      },
    )
    try {
      expect(maximumActive).toBe(1)
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })

  it('requests approval sequentially before a parallel command segment', async () => {
    const commandArgs = {
      mode: 'process',
      executable: process.execPath,
      args: ['--version'],
    }
    const result = await fixture(
      [
        { id: 'call:command-1', toolId: 'run_command', args: commandArgs },
        { id: 'call:command-2', toolId: 'run_command', args: commandArgs },
      ],
      {
        mode: 'confirm',
        async onStarted({ manager, sessionId, runId, events }) {
          await waitFor(
            () =>
              manager.activeRunSnapshot(sessionId)?.approval?.callId ===
              'call:command-1',
          )
          expect(
            events.filter(({ event }) => event.type === 'approval.requested'),
          ).toHaveLength(1)
          expect(
            manager.decideApproval({
              sessionId,
              runId,
              callId: 'call:command-1' as CallId,
              decision: 'allow',
            }),
          ).toBe(true)
          await waitFor(
            () =>
              manager.activeRunSnapshot(sessionId)?.approval?.callId ===
              'call:command-2',
          )
          expect(
            events.some(({ event }) => event.type === 'tool.completed'),
          ).toBe(false)
          expect(
            manager.decideApproval({
              sessionId,
              runId,
              callId: 'call:command-2' as CallId,
              decision: 'allow',
            }),
          ).toBe(true)
        },
      },
    )
    try {
      expect(
        result.events
          .filter(({ event }) => event.type === 'approval.requested')
          .map(({ event }) =>
            event.type === 'approval.requested' ? event.callId : undefined,
          ),
      ).toEqual(['call:command-1', 'call:command-2'])
      expect(
        result.events
          .filter(({ event }) => event.type === 'tool.completed')
          .map(({ event }) =>
            event.type === 'tool.completed' ? event.callId : undefined,
          ),
      ).toEqual(['call:command-1', 'call:command-2'])
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })
})
