import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
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

interface BatchCall {
  id: string
  toolId: string
  args: JsonObject
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

async function fixture(batch: BatchCall[]) {
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
  const runOne = vi.fn(async () => ({
    results: { worker: 'delegated result' },
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
  }))
  const provider = new BatchProvider(batch)
  const manager = new SessionManager({
    configStore,
    traceDirectory: path.join(directory, 'traces'),
    eventSink: createIpcTestEventSink((event) => events.push(event)),
    providerFactory: () => provider,
    subagentExecution: { runOne },
  })
  const sessionId = await manager.createSession({
    workspace,
    mode: 'readonly',
    provider: 'deepseek',
  })
  const runId = manager.startRun({
    sessionId,
    message: 'Run the batch',
    clientRequestId: 'request:batch',
  })
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

describe('Session Tool batch preflight', () => {
  it('executes subagent_run when it is the final call', async () => {
    const result = await fixture([
      { id: 'call:read', toolId: 'read_file', args: { path: 'README.md' } },
      {
        id: 'call:subagent',
        toolId: 'subagent_run',
        args: { name: 'worker', task: 'Inspect README directly.' },
      },
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

  it('rejects the entire batch before tools or approvals when special calls repeat', async () => {
    const result = await fixture([
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
    ])
    try {
      expect(result.runOne).not.toHaveBeenCalled()
      const completed = result.events.filter(
        ({ event }) =>
          event.type === 'tool.completed' && event.runId === result.runId,
      )
      expect(completed).toHaveLength(3)
      expect(completed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              callId: 'call:read',
              result: expect.objectContaining({
                status: 'error',
                code: 'INVALID_TOOL_BATCH',
              }),
            }),
          }),
        ]),
      )
      expect(
        result.events.some(
          ({ event }) =>
            event.type === 'approval.requested' && event.runId === result.runId,
        ),
      ).toBe(false)
    } finally {
      await result.manager.closeSession(result.sessionId)
    }
  })
})
