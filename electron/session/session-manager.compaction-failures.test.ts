import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'
import { ProviderTransportError } from '../providers/http-sse-transport'
import { MessageHistoryCompiler } from './canonical-history'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'
import type { SessionExecutionStatePort, SessionState } from './session-types'

type CompactAction = 'completed' | 'truncated' | 'network'

class CompactFailureProvider extends ScriptedProviderHarness {
  readonly compactInstructions: string[] = []
  compactCalls = 0
  mainCalls = 0

  constructor(private readonly actions: readonly CompactAction[]) {
    super()
  }

  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    if (request.toolDefinitions.length > 0) {
      this.mainCalls += 1
      yield {
        type: 'completed',
        rawResponse: { id: `main-${this.mainCalls}` },
        turn: { role: 'assistant', content: 'Durable answer before compact' },
        toolCalls: [],
        usage: { total_tokens: 10 },
        providerState: {},
        timing: {},
      }
      return
    }

    const action = this.actions[this.compactCalls] ?? 'completed'
    this.compactCalls += 1
    this.compactInstructions.push(
      String(request.normalizedMessages.at(-1)?.content ?? ''),
    )
    if (action === 'network') {
      throw new ProviderTransportError(
        'NETWORK_ERROR',
        'Temporary compact network failure',
        undefined,
        { retryAfterMs: 0 },
      )
    }
    const text =
      action === 'truncated'
        ? 'Incomplete compact checkpoint'
        : 'Complete compact checkpoint'
    yield { type: 'text.delta', delta: text, raw: { action } }
    yield {
      type: 'completed',
      rawResponse: { id: `compact-${this.compactCalls}`, action },
      turn: { role: 'assistant', content: text },
      toolCalls: [],
      usage: { total_tokens: 20 },
      finishReason: action === 'truncated' ? 'length' : 'stop',
      providerState: {},
      timing: {},
    }
  }
}

async function setup(actions: readonly CompactAction[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-fail-'))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  const configStore = await createConfig(directory)
  const provider = new CompactFailureProvider(actions)
  const events: AgentEventEnvelope[] = []
  let liveSession: SessionState | undefined
  const executionState: SessionExecutionStatePort = {
    async commit(session) {
      liveSession = session
      return undefined
    },
  }
  const manager = new SessionManager({
    configStore,
    traceDirectory: path.join(directory, 'traces'),
    eventSink: createIpcTestEventSink((event) => events.push(event)),
    providerFactory: () => provider,
    executionState,
  })
  const sessionId = await manager.createSession({
    workspace,
    mode: 'readonly',
    provider: 'deepseek',
  })
  const seedRunId = manager.startRun({
    sessionId,
    message: 'Create history to compact.',
    clientRequestId: 'request:compact-failure-seed',
  })
  await waitFor(() =>
    events.some(
      ({ event }) =>
        event.type === 'run.status' &&
        event.runId === seedRunId &&
        event.status === 'completed',
    ),
  )
  await waitFor(() => !manager.hasActiveRun(sessionId))
  return {
    manager,
    provider,
    events,
    sessionId,
    session: () => liveSession,
  }
}

describe('SessionManager compaction failures', () => {
  it('retries a truncated synthetic compact once with a shorter prompt', async () => {
    const target = await setup(['truncated', 'completed'])
    const runId = target.manager.startRun({
      sessionId: target.sessionId,
      message: '/compact',
      clientRequestId: 'request:compact-truncated-retry',
    })
    await waitFor(() =>
      target.events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'completed',
      ),
    )

    expect(target.provider.compactCalls).toBe(2)
    expect(target.provider.compactInstructions[0]).not.toContain(
      'previous compaction response was truncated',
    )
    expect(target.provider.compactInstructions[1]).toContain(
      'previous compaction response was truncated',
    )
    expect(
      target.events.some(
        ({ event }) =>
          event.type === 'assistant.text.delta' &&
          event.runId === runId &&
          event.delta === 'Incomplete compact checkpoint',
      ),
    ).toBe(false)
    expect(
      target
        .session()
        ?.history.some(
          (record) => record.kind === 'compact_summary' && record.inHistory,
        ),
    ).toBe(true)
    await target.manager.closeSession(target.sessionId)
  }, 10_000)

  it('retries two transient failures and preserves the single command journal', async () => {
    const target = await setup(['network', 'network', 'completed'])
    const runId = target.manager.startRun({
      sessionId: target.sessionId,
      message: '/compact',
      clientRequestId: 'request:compact-network-retry',
    })
    await waitFor(() =>
      target.events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'completed',
      ),
    )

    expect(target.provider.compactCalls).toBe(3)
    expect(
      target
        .session()
        ?.history.filter(
          (record) =>
            record.kind === 'user_input' &&
            record.metadata &&
            'submission' in record.metadata &&
            record.metadata.submission.type === 'control_command',
        ),
    ).toHaveLength(1)
    await target.manager.closeSession(target.sessionId)
  }, 10_000)

  it('fails with the stable UI message and leaves old history active', async () => {
    const target = await setup(['truncated', 'truncated'])
    const runId = target.manager.startRun({
      sessionId: target.sessionId,
      message: '/compact',
      clientRequestId: 'request:compact-truncated-failure',
    })
    await waitFor(() =>
      target.events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      ),
    )

    expect(target.provider.compactCalls).toBe(2)
    expect(
      target.events.find(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      )?.event,
    ).toMatchObject({
      error: {
        code: 'COMPACTION_FAILED',
        message: '压缩失败，请重试或打开新对话。',
      },
    })
    const history = target.session()?.history ?? []
    expect(history.some((record) => record.kind === 'compact_summary')).toBe(
      false,
    )
    expect(
      history.some(
        (record) =>
          record.kind === 'assistant_turn' &&
          record.inHistory &&
          record.parts.some(
            (part) =>
              part.type === 'text' &&
              part.text === 'Durable answer before compact',
          ),
      ),
    ).toBe(true)
    expect(() => new MessageHistoryCompiler().compile(history)).not.toThrow()
    await target.manager.closeSession(target.sessionId)
  }, 10_000)
})
