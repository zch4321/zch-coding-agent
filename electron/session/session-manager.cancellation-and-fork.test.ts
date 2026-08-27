import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId, EventId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  OperationalEventInput,
  OperationalLogWriteResult,
} from '../operational-logging/events'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager cancellation and forks', () => {
  class MultiToolCancellationProvider extends ScriptedProviderHarness {
    calls = 0
    requests: ProviderStreamRequest['normalizedMessages'][] = []

    async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
      this.calls += 1
      this.requests.push(structuredClone(request.normalizedMessages))

      if (this.calls === 1) {
        const toolCalls = ['first.txt', 'second.txt'].map(
          (fileName, index) => ({
            id: `call-write-${index + 1}`,
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: fileName, content: fileName }),
            },
          }),
        )
        yield {
          type: 'completed',
          rawResponse: {},
          turn: { role: 'assistant', content: null, tool_calls: toolCalls },
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id as CallId,
            toolId: 'create_file',
            args: JSON.parse(toolCall.function.arguments) as JsonValue,
            reason: 'Create cancellation fixture',
          })),
          usage: {},
          providerState: {},
          timing: {},
        }
        return
      }

      yield {
        type: 'completed',
        rawResponse: {},
        turn: { role: 'assistant', content: 'Recovered after cancellation' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }

  class MultiToolFailureProvider extends ScriptedProviderHarness {
    calls = 0
    requests: ProviderStreamRequest['normalizedMessages'][] = []

    async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
      this.calls += 1
      this.requests.push(structuredClone(request.normalizedMessages))

      if (this.calls === 1) {
        const toolCalls = ['first.txt', 'second.txt'].map(
          (fileName, index) => ({
            id: `call-read-${index + 1}`,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: fileName }),
            },
          }),
        )
        yield {
          type: 'completed',
          rawResponse: {},
          turn: { role: 'assistant', content: null, tool_calls: toolCalls },
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id as CallId,
            toolId: 'read_file',
            args: JSON.parse(toolCall.function.arguments) as JsonValue,
            reason: 'Read the failure fixture',
          })),
          usage: {},
          providerState: {},
          timing: {},
        }
        return
      }

      yield {
        type: 'completed',
        rawResponse: {},
        turn: { role: 'assistant', content: 'Recovered after sink failure' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }

  class BlockingCancellationProvider extends ScriptedProviderHarness {
    started = false

    async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
      this.started = true
      await new Promise<void>((_resolve, reject) => {
        const abort = () =>
          reject(request.signal.reason ?? new Error('Provider call cancelled'))
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
      yield* []
    }
  }

  it('records an interrupted Provider call as a cancelled Run only', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-provider-cancel-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new BlockingCancellationProvider()
    const operationalEvents: OperationalEventInput[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => provider,
      operationalLog: {
        log(input: OperationalEventInput): OperationalLogWriteResult {
          operationalEvents.push(input)
          return {
            eventId: `event:test-${operationalEvents.length}` as EventId,
            written: true,
          }
        },
      },
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Wait until cancelled',
      clientRequestId: 'request-provider-cancel',
    })

    await waitFor(() => provider.started)
    expect(manager.interruptRun(sessionId, runId)).toBe(true)
    await waitFor(() =>
      operationalEvents.some((event) => event.event === 'run.cancelled'),
    )

    expect(
      operationalEvents.some((event) => event.event === 'provider.failed'),
    ).toBe(false)
    expect(
      operationalEvents.some((event) => event.event === 'run.failed'),
    ).toBe(false)
    expect(
      operationalEvents.find((event) => event.event === 'provider.completed'),
    ).toMatchObject({ level: 'debug', outcome: 'cancelled' })
    await manager.closeSession(sessionId)
  })

  it('fills every tool result when a multi-tool turn is interrupted', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-cancel-tools-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new MultiToolCancellationProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    } as WebContents
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) =>
        webContents.send('', envelope),
      ),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const firstRunId = manager.startRun({
      sessionId,
      message: 'Create both files',
      clientRequestId: 'request-cancel-tools',
    })

    await waitFor(() =>
      sent.some((envelope) => envelope.event.type === 'approval.requested'),
    )
    expect(manager.interruptRun(sessionId, firstRunId)).toBe(true)
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === firstRunId &&
          envelope.event.status === 'cancelled',
      ),
    )
    const cancellingIndex = sent.findIndex(
      ({ event }) =>
        event.type === 'run.status' &&
        event.runId === firstRunId &&
        event.status === 'cancelling',
    )
    expect(cancellingIndex).toBeGreaterThanOrEqual(0)
    expect(
      sent
        .slice(cancellingIndex + 1)
        .some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === firstRunId &&
            event.status === 'running_tools',
        ),
    ).toBe(false)
    expect(manager.interruptRun(sessionId, firstRunId)).toBe(false)

    manager.continueRun({
      sessionId,
      clientRequestId: 'request-after-cancel',
    })
    await waitFor(() => provider.calls === 2)

    expect(
      provider.requests[1]?.filter((message) => message.role === 'user'),
    ).toHaveLength(
      provider.requests[0]?.filter((message) => message.role === 'user')
        .length ?? 0,
    )
    expect(
      provider.requests[1]?.filter((message) => message.role === 'tool'),
    ).toHaveLength(2)
    expect(
      await readFile(path.join(workspace, 'first.txt'), 'utf8').catch(
        () => 'missing',
      ),
    ).toBe('missing')
    await manager.closeSession(sessionId)
  })

  it('fills every tool result when a tool batch fails between calls', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-failed-tools-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new MultiToolFailureProvider()
    const sent: AgentEventEnvelope[] = []
    let failNextToolCompletion = true
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => {
        if (
          failNextToolCompletion &&
          envelope.event.type === 'tool.completed'
        ) {
          failNextToolCompletion = false
          throw new Error('fixture event sink failure')
        }
        sent.push(envelope)
      }),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const firstRunId = manager.startRun({
      sessionId,
      message: 'Read both files',
      clientRequestId: 'request-failed-tools',
    })

    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === firstRunId &&
          event.status === 'failed',
      ),
    )
    const failedRun = sent.find(
      ({ event }) =>
        event.type === 'run.status' &&
        event.runId === firstRunId &&
        event.status === 'failed',
    )
    expect(
      failedRun?.event.type === 'run.status'
        ? failedRun.event.error?.code
        : undefined,
    ).toBe('TOOL_BATCH_FAILED')
    manager.startRun({
      sessionId,
      message: 'Continue after the infrastructure failure',
      clientRequestId: 'request-after-failed-tools',
    })
    await waitFor(() => provider.calls === 2)

    expect(
      provider.requests[1]?.filter((message) => message.role === 'tool'),
    ).toHaveLength(2)
    await manager.closeSession(sessionId)
  })
})
