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
  calls = 0
  requests: TestProviderStreamRequest[] = []
  release!: () => void
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  constructor(readonly tools: boolean) {
    super()
  }

  /** Produces a complete tool batch or final answer after a controlled stream. */
  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    this.calls += 1
    this.requests.push(request)
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
        toolCalls: this.tools
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
    yield { type: 'completed', turn: { role: 'assistant', content: 'Done' } }
  }
}

async function fixture(tools = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-run-pause-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'notes.md'), 'durable tool result')
  const provider = new PauseProvider(tools)
  let committed: MessageRecord[] = []
  const manager = new SessionManager({
    configStore: await createConfig(root),
    traceDirectory: path.join(root, 'traces'),
    providerFactory: () => provider,
    eventSink: createIpcTestEventSink(() => undefined),
    executionState: {
      async commit(session) {
        committed = structuredClone(session.history)
        return undefined
      },
    },
  })
  cleanup.push(() => manager.dispose())
  const sessionId = await manager.createSession({
    workspace,
    mode: 'yolo',
    provider: 'deepseek',
  })
  const runId = manager.startRun({
    sessionId,
    message: 'Inspect files',
    clientRequestId: 'pause-request',
  })
  await waitFor(() => provider.calls === 1)
  return { manager, provider, sessionId, runId, history: () => committed }
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
