import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceEvent, TraceEventInput } from '../logging/events'
import { NullTraceLogger, type TraceLogger } from '../logging/logger'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  ForkProvider,
} from './session-manager-test-support'

class FailFirstUserMessageLogger implements TraceLogger {
  readonly #delegate = new NullTraceLogger()
  readonly #failUserMessage: boolean

  constructor(failUserMessage: boolean) {
    this.#failUserMessage = failUserMessage
  }

  get queuePeak(): number {
    return this.#delegate.queuePeak
  }

  async write(input: TraceEventInput): Promise<TraceEvent> {
    if (this.#failUserMessage && input.type === 'user.message') {
      throw new Error('Injected user trace failure')
    }
    return this.#delegate.write(input)
  }

  dispose(): Promise<void> {
    return this.#delegate.dispose()
  }
}

describe('SessionManager precommit recovery', () => {
  it('degrades trace failures without failing a run and retries next run', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-precommit-recovery-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const provider = new ForkProvider()
    let loggerCreations = 0
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => provider,
      traceLoggerFactory: () =>
        new FailFirstUserMessageLogger(loggerCreations++ === 0),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    try {
      const firstRun = manager.startRun({
        sessionId,
        message: 'first input survives trace failure',
        clientRequestId: 'request:first-input',
      })
      await manager.waitForRunSettled(sessionId, firstRun)
      expect(provider.calls).toBe(1)
      expect(loggerCreations).toBe(1)
      expect(manager.traceCaptureStatus(sessionId)).toMatchObject({
        configuredEnabled: true,
        state: 'degraded',
        warning: 'Injected user trace failure',
      })

      const secondRun = manager.startRun({
        sessionId,
        message: 'second input',
        clientRequestId: 'request:second-input',
      })
      await manager.waitForRunSettled(sessionId, secondRun)

      expect(provider.calls).toBe(2)
      expect(loggerCreations).toBe(2)
      expect(manager.traceCaptureStatus(sessionId)).toMatchObject({
        configuredEnabled: true,
        state: 'active',
      })
      expect(JSON.stringify(provider.messages)).toContain(
        'first input survives trace failure',
      )
      expect(JSON.stringify(provider.messages)).toContain('second input')
    } finally {
      await manager.dispose()
    }
  })
})
