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

describe('SessionManager workspace concurrency', () => {
  /** Holds every Provider request until the test releases its matching task. */
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

    /** Releases the Provider request containing the specified user text. */
    releaseRequestContaining(text: string): void {
      const index = this.requests.findIndex((messages) =>
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes(text),
        ),
      )
      if (index < 0) throw new Error(`Provider request not found: ${text}`)
      this.#releases[index]?.()
    }
  }

  it('allows every conversation to run concurrently in one workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-concurrent-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const provider = new ConcurrentGateProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const modes = ['auto', 'confirm', 'yolo', 'readonly', 'confirm'] as const
    const sessions = await Promise.all(
      modes.map((mode) =>
        manager.createSession({ workspace, mode, provider: 'deepseek' }),
      ),
    )
    const messages = modes.map((_, index) => `Concurrent task ${index + 1}`)
    const runs = sessions.map((sessionId, index) =>
      manager.startRun({
        sessionId,
        message: messages[index]!,
        clientRequestId: `concurrent-${index + 1}`,
      }),
    )

    await waitFor(() => provider.requests.length === sessions.length)
    expect(
      provider.requests.every((request) =>
        request.every(
          (message) =>
            typeof message.content !== 'string' ||
            !message.content.includes('<workspace_concurrency'),
        ),
      ),
    ).toBe(true)
    await expect(
      manager.updateSessionMode(sessions[3]!, 'confirm'),
    ).resolves.toMatchObject({ reason: 'active_run' })

    for (const message of messages) provider.releaseRequestContaining(message)
    await waitFor(() =>
      runs.every((runId) =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === runId &&
            event.status === 'completed',
        ),
      ),
    )
    await waitFor(() =>
      sessions.every((sessionId) => !manager.hasActiveRun(sessionId)),
    )

    await expect(
      manager.updateSessionMode(sessions[3]!, 'confirm'),
    ).resolves.toEqual({ accepted: true })
    await manager.dispose()
    const trace = await readSessionTrace(directory, sessions[0]!)
    expect(trace).not.toContain('workspace.writer')
    expect(trace).not.toContain('max_concurrent_runs')
  })
})
