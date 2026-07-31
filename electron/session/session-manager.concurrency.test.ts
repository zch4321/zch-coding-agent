import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  readSessionTrace,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager M1 workspace concurrency', () => {
  class ConcurrentGateProvider extends ScriptedProviderHarness {
    readonly requests: ProviderStreamRequest['normalizedMessages'][] = []
    readonly #releases: Array<() => void> = []

    async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
      const index = this.requests.length
      this.requests.push(structuredClone(request.normalizedMessages))
      await new Promise<void>((resolve) => {
        this.#releases[index] = resolve
      })
      yield {
        type: 'completed',
        rawResponse: { id: `concurrent-${index}` },
        turn: { role: 'assistant', content: `completed-${index}` },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }

    release(index: number): void {
      this.#releases[index]?.()
    }

    requestContaining(
      text: string,
    ): ProviderStreamRequest['normalizedMessages'] | undefined {
      return this.requests.find((messages) =>
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            String(message.content ?? '').includes(text),
        ),
      )
    }

    releaseRequestContaining(text: string): void {
      const index = this.requests.findIndex((messages) =>
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            String(message.content ?? '').includes(text),
        ),
      )
      if (index < 0) throw new Error(`Provider request not found: ${text}`)
      this.release(index)
    }
  }

  function lastWorkspaceConcurrency(
    messages: ProviderStreamRequest['normalizedMessages'],
  ): string {
    return String(
      messages
        .filter(
          (message) =>
            typeof message.content === 'string' &&
            String(message.content ?? '').includes('<workspace_concurrency'),
        )
        .at(-1)?.content ?? '',
    )
  }

  async function waitForModeUpdate(
    manager: SessionManager,
    sessionId: Parameters<SessionManager['updateSessionMode']>[0],
    mode: Parameters<SessionManager['updateSessionMode']>[1],
  ): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const result = await manager.updateSessionMode(sessionId, mode)
      if (result.accepted) return
      if (result.reason !== 'active_run') {
        throw new Error(`Unexpected mode update rejection: ${result.reason}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Timed out waiting for the session run to settle')
  }

  it('enforces the configured active-run limit and one writer per canonical workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-m1-'))
    const workspaceA = path.join(directory, 'workspace-a')
    const workspaceB = path.join(directory, 'workspace-b')
    const workspaceC = path.join(directory, 'workspace-c')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(workspaceC)])
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'limits',
      value: {
        ...store.getPublicConfig().limits,
        maxConcurrentRuns: 4,
      },
    })
    const provider = new ConcurrentGateProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const writerSession = await manager.createSession({
      workspace: workspaceA,
      mode: 'auto',
      provider: 'deepseek',
    })
    const readerSession = await manager.createSession({
      workspace: workspaceA,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const otherWriterSession = await manager.createSession({
      workspace: workspaceB,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const otherReaderSession = await manager.createSession({
      workspace: workspaceB,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const fifthSession = await manager.createSession({
      workspace: workspaceC,
      mode: 'readonly',
      provider: 'deepseek',
    })

    const writerRun = manager.startRun({
      sessionId: writerSession,
      message: 'Hold writer A',
      clientRequestId: 'm1-writer-a',
    })
    await waitFor(() => provider.requests.length === 1)
    expect(
      lastWorkspaceConcurrency(provider.requestContaining('Hold writer A')!),
    ).toContain('status="writer"')
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'workspace.writer.changed' &&
          event.status === 'acquired' &&
          event.writerRunId === writerRun,
      ),
    ).toBe(true)

    await expect(
      manager.updateSessionMode(readerSession, 'confirm'),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'workspace_writer_active',
      writerSessionId: writerSession,
      writerRunId: writerRun,
    })
    expect(() =>
      manager.startRun({
        sessionId: readerSession,
        message: 'Must not write concurrently',
        clientRequestId: 'm1-rejected-writer',
      }),
    ).toThrow('Another run is modifying this workspace')

    await expect(
      manager.updateSessionMode(readerSession, 'readonly'),
    ).resolves.toEqual({ accepted: true })
    const readerRun = manager.startRun({
      sessionId: readerSession,
      message: 'Read while writer A is active',
      clientRequestId: 'm1-reader-a',
    })
    const otherWriterRun = manager.startRun({
      sessionId: otherWriterSession,
      message: 'Hold writer B',
      clientRequestId: 'm1-writer-b',
    })
    const otherReaderRun = manager.startRun({
      sessionId: otherReaderSession,
      message: 'Read workspace B',
      clientRequestId: 'm1-reader-b',
    })
    await waitFor(() => provider.requests.length === 4)
    const readerARequest = provider.requestContaining(
      'Read while writer A is active',
    )!
    expect(lastWorkspaceConcurrency(readerARequest)).toContain(
      'status="readonly_locked"',
    )
    expect(lastWorkspaceConcurrency(readerARequest)).toContain(writerSession)
    expect(
      lastWorkspaceConcurrency(provider.requestContaining('Hold writer B')!),
    ).toContain('status="writer"')

    expect(() =>
      manager.startRun({
        sessionId: fifthSession,
        message: 'Fifth run',
        clientRequestId: 'm1-fifth',
      }),
    ).toThrow('maximum number of concurrent runs')

    for (const message of [
      'Hold writer A',
      'Read while writer A is active',
      'Hold writer B',
      'Read workspace B',
    ]) {
      provider.releaseRequestContaining(message)
    }
    const initialRuns = [writerRun, readerRun, otherWriterRun, otherReaderRun]
    await waitFor(() =>
      initialRuns.every((runId) =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === runId &&
            event.status === 'completed',
        ),
      ),
    )

    const availableRun = manager.startRun({
      sessionId: readerSession,
      message: 'Read after writers released',
      clientRequestId: 'm1-reader-available',
    })
    await waitFor(() => provider.requests.length === 5)
    expect(
      lastWorkspaceConcurrency(
        provider.requestContaining('Read after writers released')!,
      ),
    ).toContain('status="available"')
    provider.releaseRequestContaining('Read after writers released')
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === availableRun &&
          event.status === 'completed',
      ),
    )
    await waitForModeUpdate(manager, readerSession, 'confirm')
    const nextWriterRun = manager.startRun({
      sessionId: readerSession,
      message: 'Writer after release',
      clientRequestId: 'm1-next-writer',
    })
    await waitFor(() => provider.requests.length === 6)
    expect(
      lastWorkspaceConcurrency(
        provider.requestContaining('Writer after release')!,
      ),
    ).toContain('status="writer"')
    provider.releaseRequestContaining('Writer after release')
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === nextWriterRun &&
          event.status === 'completed',
      ),
    )

    await manager.dispose()
    const trace = await readSessionTrace(directory, readerSession)
    expect(trace).toContain('"type":"run.rejected"')
    expect(trace).toContain('"status":"rejected"')
    expect(trace).toContain('"status":"acquired"')
    expect(trace).toContain('"status":"released"')
  })
})
