import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** Holds a streamed response open until the test requests a safe pause. */
class PauseProvider extends ScriptedProviderHarness {
  compactStarted = false
  releaseCompact!: () => void
  readonly compactGate = new Promise<void>((resolve) => {
    this.releaseCompact = resolve
  })
  calls = 0
  requests: TestProviderStreamRequest[] = []
  release!: () => void
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  constructor(
    readonly tools: boolean,
    readonly exec = false,
    readonly enableCompact = false,
  ) {
    super()
  }

  /** Produces a complete tool batch or final answer after a controlled stream. */
  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    this.calls += 1
    this.requests.push(request)
    if (this.enableCompact && request.toolDefinitions.length === 0) {
      this.compactStarted = true
      await this.compactGate
      yield {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: 'Safe compact checkpoint retained',
        },
        usage: { total_tokens: 10 },
      }
      return
    }
    if (this.calls === 1) {
      yield {
        type: 'reasoning.delta',
        delta: 'Thinking through the current response',
        raw: {},
      }
      yield { type: 'text.delta', delta: 'Inspecting the files', raw: {} }
      await this.gate
      request.signal.throwIfAborted()
      yield {
        type: 'completed',
        turn: { role: 'assistant', content: 'Inspecting the files' },
        ...(this.enableCompact
          ? {
              usage: {
                prompt_tokens: 2000,
                completion_tokens: 10,
                total_tokens: 2010,
              },
            }
          : {}),
        toolCalls: this.exec
          ? [
              {
                id: 'call:pause-exec' as CallId,
                toolId: 'exec_command',
                args: {
                  executable: process.execPath,
                  args: [
                    '-e',
                    "process.stdin.once('data',b=>{process.stdout.write('received:'+b.toString(),()=>process.exit(0))});process.stdin.resume()",
                  ],
                  yieldTimeMs: 0,
                },
                reason: 'Start retained stdin process',
              },
            ]
          : this.tools
            ? [1, 2].map((i) => ({
                id: `call:read-${i}` as CallId,
                toolId: 'read_file',
                args: { path: 'notes.md' },
                reason: 'Read file',
              }))
            : [],
      }
      return
    }
    if (this.exec && this.calls === 2) {
      const result = [...request.normalizedMessages]
        .reverse()
        .find((message) => message.role === 'tool')
      const handle = JSON.parse(
        String(result?.content).split('\n')[0]!,
      ).sessionId
      yield {
        type: 'completed',
        turn: { role: 'assistant', content: null },
        toolCalls: [
          {
            id: 'call:resume-stdin' as CallId,
            toolId: 'exec_command',
            args: {
              sessionId: handle,
              chars: 'resume-check\n',
              yieldTimeMs: 3000,
            },
            reason: 'Use the existing process after resume',
          },
        ],
      }
      return
    }
    yield { type: 'completed', turn: { role: 'assistant', content: 'Done' } }
  }
}

async function fixture(
  tools = true,
  exec = false,
  mode: 'yolo' | 'confirm' = 'yolo',
  compact = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-run-pause-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'notes.md'), 'durable tool result')
  const provider = new PauseProvider(tools, exec, compact)
  const configStore = await createConfig(root)
  if (compact)
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'pause-compact-model',
      contextWindowTokens: 160000,
      compactThresholdTokens: 1024,
      maxOutputTokens: 8000,
    })
  let committed: MessageRecord[] = []
  let failure: unknown
  const manager = new SessionManager({
    configStore,
    traceDirectory: path.join(root, 'traces'),
    providerFactory: () => provider,
    eventSink: createIpcTestEventSink(({ event }) => {
      if (event.type === 'run.status' && event.error) failure = event.error
    }),
    executionState: {
      async commit(session) {
        committed = structuredClone(session.history)
        return undefined
      },
    },
  })
  cleanup.push(() => {
    provider.release()
    provider.releaseCompact()
    return manager.dispose()
  })
  const sessionId = await manager.createSession({
    workspace,
    mode,
    provider: 'deepseek',
    ...(compact
      ? {
          modelSelection: {
            providerId: 'deepseek',
            model: 'pause-compact-model',
            reasoning: 'off' as const,
          },
        }
      : {}),
  })
  const runId = manager.startRun({
    sessionId,
    message: 'Inspect files',
    clientRequestId: 'pause-request',
  })
  await waitFor(() => provider.calls === 1)
  return {
    manager,
    provider,
    sessionId,
    runId,
    history: () => committed,
    failure: () => failure,
  }
}

describe('safe Run suspension', () => {
  it('finishes a response and every tool result before parking, then continues the same Run', async () => {
    const value = await fixture()
    const { manager, provider, sessionId, runId } = value
    expect(manager.pauseRun(sessionId, runId, 'timeout')).toBe(true)
    expect(provider.requests[0]!.signal.aborted).toBe(false)
    provider.release()
    await waitFor(
      () => manager.activeRunSnapshot(sessionId)?.status === 'paused',
    )
    expect(provider.calls).toBe(1)
    expect(
      value.history().filter((m) => m.kind === 'tool_result'),
    ).toHaveLength(2)
    expect(manager.activeRunSnapshot(sessionId)?.runId).toBe(runId)
    expect(manager.resumePausedRun(sessionId, runId)).toBe(true)
    await manager.waitForRunSettled(sessionId, runId)
    expect(provider.calls).toBe(2)
    expect(JSON.stringify(provider.requests[1]!.normalizedMessages)).toContain(
      'durable tool result',
    )
    expect(
      value.history().filter((m) => m.kind === 'tool_result'),
    ).toHaveLength(2)
  })

  it('finishes a final answer instead of parking an already complete task', async () => {
    const { manager, provider, sessionId, runId } = await fixture(false)
    manager.pauseRun(sessionId, runId, 'timeout')
    provider.release()
    await manager.waitForRunSettled(sessionId, runId)
    expect(provider.calls).toBe(1)
    expect(manager.activeRunSnapshot(sessionId)).toBeUndefined()
  })

  it.each(['yolo', 'confirm'] as const)(
    'retains an exec stdin handle and ordinary approvals across pause (%s)',
    async (mode) => {
      const value = await fixture(true, true, mode)
      const { manager, provider, sessionId, runId } = value
      manager.pauseRun(sessionId, runId, 'timeout')
      provider.release()
      if (mode === 'confirm') {
        await waitFor(() => !!manager.activeRunSnapshot(sessionId)?.approval)
        expect(manager.activeRunSnapshot(sessionId)?.status).toBe(
          'awaiting_approval',
        )
        manager.decideApproval({
          sessionId,
          runId,
          callId: manager.activeRunSnapshot(sessionId)!.approval!.callId,
          decision: 'allow',
        })
      }
      await waitFor(
        () => manager.activeRunSnapshot(sessionId)?.status === 'paused',
      )
      expect(
        value.history().filter((message) => message.kind === 'tool_result'),
      ).toHaveLength(1)
      manager.resumePausedRun(sessionId, runId)
      if (mode === 'confirm') {
        await waitFor(() => !!manager.activeRunSnapshot(sessionId)?.approval)
        manager.decideApproval({
          sessionId,
          runId,
          callId: manager.activeRunSnapshot(sessionId)!.approval!.callId,
          decision: 'allow',
        })
      }
      await manager.waitForRunSettled(sessionId, runId)
      expect(provider.requests).toHaveLength(3)
      expect(
        JSON.stringify(provider.requests[2]!.normalizedMessages),
      ).toContain('received:resume-check')
      expect(
        value.history().filter((message) => message.kind === 'tool_result'),
      ).toHaveLength(2)
    },
  )

  it('commits an already running compaction before pausing and does not launch the next model request', async () => {
    const value = await fixture(true, false, 'yolo', true)
    const { manager, provider, sessionId, runId } = value
    provider.release()
    await waitFor(
      () => provider.compactStarted || !manager.activeRunSnapshot(sessionId),
    )
    expect(
      provider.compactStarted,
      JSON.stringify({
        failure: value.failure(),
        requests: provider.requests.map((r) => ({
          model: r.providerRequest.model,
          tools: r.toolDefinitions.length,
        })),
      }),
    ).toBe(true)
    manager.pauseRun(sessionId, runId, 'timeout')
    expect(provider.requests[1]!.signal.aborted).toBe(false)
    provider.releaseCompact()
    await waitFor(
      () => manager.activeRunSnapshot(sessionId)?.status === 'paused',
    )
    expect(provider.calls).toBe(2)
    expect(JSON.stringify(value.history())).toContain(
      'Safe compact checkpoint retained',
    )
    manager.resumePausedRun(sessionId, runId)
    await manager.waitForRunSettled(sessionId, runId)
    expect(provider.calls).toBe(3)
    expect(JSON.stringify(provider.requests[2]!.normalizedMessages)).toContain(
      'Safe compact checkpoint retained',
    )
  })

  it('cancels a parked Run without requiring resume', async () => {
    const { manager, provider, sessionId, runId } = await fixture()
    manager.pauseRun(sessionId, runId)
    provider.release()
    await waitFor(
      () => manager.activeRunSnapshot(sessionId)?.status === 'paused',
    )
    expect(manager.interruptRun(sessionId, runId)).toBe(true)
    await manager.waitForRunSettled(sessionId, runId)
    expect(provider.calls).toBe(1)
    expect(provider.requests[0]!.signal.aborted).toBe(true)
  })
})
