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
  #failed = false

  get queuePeak(): number {
    return this.#delegate.queuePeak
  }

  async write(input: TraceEventInput): Promise<TraceEvent> {
    if (!this.#failed && input.type === 'user.message') {
      this.#failed = true
      throw new Error('Injected user trace failure')
    }
    return this.#delegate.write(input)
  }

  dispose(): Promise<void> {
    return this.#delegate.dispose()
  }
}

describe('SessionManager precommit recovery', () => {
  it('does not carry a failed user input into the next run', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-precommit-recovery-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const provider = new ForkProvider()
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => provider,
      traceLoggerFactory: () => new FailFirstUserMessageLogger(),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    try {
      const failedRun = manager.startRun({
        sessionId,
        message: 'failed input must not survive',
        clientRequestId: 'request:failed-input',
      })
      await manager.waitForRunSettled(sessionId, failedRun)
      expect(provider.calls).toBe(0)

      const successfulRun = manager.startRun({
        sessionId,
        message: 'fresh input',
        clientRequestId: 'request:fresh-input',
      })
      await manager.waitForRunSettled(sessionId, successfulRun)

      expect(provider.calls).toBe(1)
      expect(JSON.stringify(provider.messages)).toContain('fresh input')
      expect(JSON.stringify(provider.messages)).not.toContain(
        'failed input must not survive',
      )
    } finally {
      await manager.dispose()
    }
  })
})
