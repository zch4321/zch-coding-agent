import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { delay } from '../../shared/async/delay'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'
import { SessionManager } from './session-manager'
import { CommandSessionManager } from '../process/command-sessions'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Runs a yielded process and pauses the model continuation for lifecycle assertions. */
class ExecProvider extends ScriptedProviderHarness {
  calls = 0
  release: () => void = () => undefined
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  constructor(
    readonly script: string,
    readonly fail: boolean,
  ) {
    super()
  }

  /** Produces one exec call, then a controlled final response or failure. */
  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    if (++this.calls === 1) {
      yield {
        type: 'completed',
        turn: { role: 'assistant', content: null },
        toolCalls: [
          {
            id: 'call:exec' as CallId,
            toolId: 'exec_command',
            args: {
              executable: process.execPath,
              args: ['-e', this.script],
              yieldTimeMs: 0,
            },
            reason: 'Start a process for this Run',
          },
        ],
      }
      return
    }
    await Promise.race([this.gate, delay(60_000, request.signal)])
    if (this.fail) throw new Error('fixture permanent provider failure')
    yield {
      type: 'completed',
      turn: { role: 'assistant', content: 'Run complete' },
    }
  }
}

async function fixture(fail = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'exec-run-test-'))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  const pidFile = path.join(workspace, 'pid.txt')
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
  const provider = new ExecProvider(script, fail)
  const configStore = await createConfig(directory)
  const events: AgentEventEnvelope[] = []
  const manager = new SessionManager({
    configStore,
    traceDirectory: path.join(directory, 'traces'),
    providerFactory: () => provider,
    eventSink: createIpcTestEventSink((event) => events.push(event)),
  })
  const sessionId = await manager.createSession({
    workspace,
    mode: 'yolo',
    provider: 'deepseek',
  })
  const runId = manager.startRun({
    sessionId,
    message: 'Exercise exec lifecycle',
    clientRequestId: 'request:exec',
  })
  await waitFor(() => provider.calls === 2)
  let pid = 0
  await vi.waitFor(async () => {
    pid = Number(await readFile(pidFile, 'utf8'))
    expect(exists(pid)).toBe(true)
  })
  return { manager, provider, events, sessionId, runId, pid }
}

describe('exec lifetime in the Session Run controller', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'settles yielded processes before publishing %s',
    async (status) => {
      const value = await fixture(status === 'failed')
      try {
        expect(
          value.manager
            .backgroundTerminalPool()
            .listBackground(value.sessionId),
        ).toHaveLength(0)
        if (status === 'cancelled')
          value.manager.interruptRun(value.sessionId, value.runId)
        else value.provider.release()
        await value.manager.waitForRunSettled(value.sessionId, value.runId)
        expect(exists(value.pid)).toBe(false)
        expect(value.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({
                type: 'run.status',
                runId: value.runId,
                status,
              }),
            }),
          ]),
        )
        expect(value.manager.hasActiveRun(value.sessionId)).toBe(false)
      } finally {
        value.provider.release()
        await value.manager.closeSession(value.sessionId)
      }
    },
    20000,
  )

  it('does not advertise completion or accept a new Run while exec cleanup is pending', async () => {
    const value = await fixture()
    let release!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = CommandSessionManager.prototype.finishRun
    const finish = vi
      .spyOn(CommandSessionManager.prototype, 'finishRun')
      .mockImplementation(async function (this: CommandSessionManager, owner) {
        await cleanupGate
        await original.call(this, owner)
      })
    try {
      value.provider.release()
      await vi.waitFor(() => expect(finish).toHaveBeenCalled())
      expect(
        value.events.some(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ),
      ).toBe(false)
      expect(() =>
        value.manager.startRun({
          sessionId: value.sessionId,
          message: 'too early',
          clientRequestId: 'request:too-early',
        }),
      ).toThrow(/active run/u)
      release()
      await value.manager.waitForRunSettled(value.sessionId, value.runId)
      expect(exists(value.pid)).toBe(false)
    } finally {
      release()
      finish.mockRestore()
      await value.manager.closeSession(value.sessionId)
    }
  }, 20000)
})
