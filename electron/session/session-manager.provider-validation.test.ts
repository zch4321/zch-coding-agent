import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId, DiagnosticId, EventId, ProjectId } from '../../shared/ids'
import type { OperationalEventInput } from '../operational-logging/events'
import type { SessionRecord } from '../../shared/session'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
} from '../providers/provider-test-harness'
import { ProviderTransportError } from '../providers/http-sse-transport'
import type { SessionExecutionStatePort, SessionState } from './session-types'
import {
  createConfig,
  createIpcTestEventSink,
  parseTrace,
  readSessionTrace,
  waitFor,
} from './session-manager-test-support'
import { SessionManager } from './session-manager'

class InvalidThenValidProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      const args = { path: 'README.md' }
      yield {
        type: 'completed',
        rawResponse: { id: 'invalid-duplicate-call' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:duplicate',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
            {
              id: 'call:duplicate',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:duplicate' as CallId,
            toolId: 'read_file',
            args,
            reason: '',
          },
          {
            id: 'call:duplicate' as CallId,
            toolId: 'read_file',
            args,
            reason: '',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'valid-follow-up' },
      turn: { role: 'assistant', content: 'Recovered safely' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class CrossTurnDuplicateProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls <= 2) {
      const args = { path: 'README.md' }
      yield {
        type: 'completed',
        rawResponse: { id: `duplicate-across-turn:${this.calls}` },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:reused-across-turns',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:reused-across-turns' as CallId,
            toolId: 'read_file',
            args,
            reason: '',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'valid-after-cross-turn-rejection' },
      turn: { role: 'assistant', content: 'Recovered after duplicate' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class ReasoningOnlyProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    yield {
      type: 'completed',
      rawResponse: { id: 'reasoning-only' },
      turn: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Unfinished reasoning',
      },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
      finishReason: 'length',
    }
  }
}

class PartialFailureThenValidProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield {
        type: 'reasoning.delta',
        delta: 'Discarded reasoning',
        raw: { attempt: 1 },
      }
      yield {
        type: 'text.delta',
        delta: 'Discarded partial answer',
        raw: { attempt: 1 },
      }
      throw new ProviderTransportError(
        'NETWORK_ERROR',
        'Temporary Provider disconnect',
        undefined,
        { retryAfterMs: 0 },
      )
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'retry-recovered' },
      turn: { role: 'assistant', content: 'Recovered answer' },
      toolCalls: [],
      usage: { total_tokens: 7 },
      providerState: {},
      timing: {},
    }
  }
}

class ToolThenFinalProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      const args = { path: 'README.md' }
      yield {
        type: 'completed',
        rawResponse: { id: 'legacy-fixture-tool' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:legacy-fixture',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:legacy-fixture' as CallId,
            toolId: 'read_file',
            args,
            reason: 'Create a projected result fixture',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'legacy-fixture-final' },
      turn: { role: 'assistant', content: 'Initial run complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

/** Bypasses the typed fixture normalizer to return a malformed canonical turn. */
class MissingUsageProvider extends ScriptedProviderHarness {
  async *run(): AsyncIterable<never> {
    yield* []
  }

  async *stream(): AsyncIterable<never> {
    yield {
      type: 'completed',
      rawResponse: { id: 'missing-usage' },
      turn: {
        parts: [{ type: 'text', text: 'Malformed completion' }],
        toolCalls: [],
        finishReason: 'completed',
      },
      providerState: { stage: 'malformed' },
      timing: { ttftMs: 1, totalMs: 2, responseBytes: 3 },
    } as never
  }
}

describe('SessionManager Provider completion validation', () => {
  it('rejects legacy Tool Results before same-route and route-transition Provider calls', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-legacy-result-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), 'legacy fixture\n')
    const configStore = await createConfig(directory)
    const config = configStore.getPublicConfig()
    const configuredProvider = config.models.providers[0]!
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: configuredProvider.id,
      label: configuredProvider.label,
      providerType: configuredProvider.providerType,
      baseURL: configuredProvider.baseURL,
      model: configuredProvider.model,
      enabledModelIds: [configuredProvider.model, 'legacy-transition-model'],
      limits: config.limits,
    })
    const provider = new ToolThenFinalProvider()
    const events: AgentEventEnvelope[] = []
    let currentSession: SessionState | undefined
    const executionState: SessionExecutionStatePort = {
      commit: async (session) => {
        currentSession = session
        return undefined
      },
    }
    let providerFactoryCalls = 0
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => {
        providerFactoryCalls += 1
        return provider
      },
      executionState,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const initialRunId = manager.startRun({
      sessionId,
      message: 'Read the fixture',
      clientRequestId: 'request:legacy-fixture',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === initialRunId &&
          event.status === 'completed',
      ),
    )
    await waitFor(() => !manager.hasActiveRun(sessionId))
    const toolResult = currentSession?.history.find(
      (record) => record.kind === 'tool_result',
    )
    if (!toolResult || toolResult.kind !== 'tool_result') {
      throw new Error('Projected Tool Result fixture is missing')
    }
    if (!toolResult.metadata)
      throw new Error('Tool metadata fixture is missing')
    expect(toolResult.metadata.tool.resultProjection).toBe('model-content.v1')
    delete toolResult.metadata.tool.resultProjection
    const callsBeforeLegacyRun = providerFactoryCalls

    const legacyRunId = manager.startRun({
      sessionId,
      message: 'Continue this conversation',
      clientRequestId: 'request:legacy-rejected',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === legacyRunId &&
          event.status === 'failed',
      ),
    )

    expect(providerFactoryCalls).toBe(callsBeforeLegacyRun)
    expect(provider.calls).toBe(2)
    expect(
      events.find(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === legacyRunId &&
          event.status === 'failed',
      )?.event,
    ).toMatchObject({
      status: 'failed',
      error: { code: 'LEGACY_TOOL_RESULT_UNSUPPORTED' },
    })
    expect(
      events.filter(
        ({ event }) =>
          event.type === 'llm.usage' && event.runId === legacyRunId,
      ),
    ).toEqual([])

    await waitFor(() => !manager.hasActiveRun(sessionId))
    const timestamp = '2026-08-09T00:00:00.000Z'
    const transitionRecord: SessionRecord = {
      schemaVersion: 1,
      id: sessionId,
      projectId: 'project:legacy-transition' as ProjectId,
      title: 'Legacy transition fixture',
      titleSource: 'user',
      lifecycle: 'active',
      permissionMode: 'readonly',
      modelSelection: {
        providerId: configuredProvider.id,
        model: 'legacy-transition-model',
        reasoning: config.models.defaultModelReasoning,
      },
      goal: null,
      plan: null,
      revision: 2,
      lastSeq: currentSession?.history.at(-1)?.seq ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    manager.applyDurableSessionRecord(transitionRecord)
    const callsBeforeTransition = providerFactoryCalls
    const transitionRunId = manager.startRun({
      sessionId,
      message: 'Attempt a route transition',
      clientRequestId: 'request:legacy-transition-rejected',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === transitionRunId &&
          event.status === 'failed',
      ),
    )

    expect(providerFactoryCalls).toBe(callsBeforeTransition)
    expect(provider.calls).toBe(2)
    expect(
      events.find(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === transitionRunId &&
          event.status === 'failed',
      )?.event,
    ).toMatchObject({
      status: 'failed',
      error: { code: 'LEGACY_TOOL_RESULT_UNSUPPORTED' },
    })
    expect(
      currentSession?.history.some(
        (record) => record.kind === 'conversation_transcript',
      ),
    ).toBe(false)
    await manager.closeSession(sessionId)
  })

  it('rejects before tools or canonical append and accepts the next run', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-validation-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const provider = new InvalidThenValidProvider()
    const events: AgentEventEnvelope[] = []
    const committedHistories: SessionState['history'][] = []
    const executionState: SessionExecutionStatePort = {
      commit: async (session) => {
        committedHistories.push(structuredClone(session.history))
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
      mode: 'confirm',
      provider: 'deepseek',
    })

    const rejectedRunId = manager.startRun({
      sessionId,
      message: 'Read the file',
      clientRequestId: 'request:invalid-provider',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === rejectedRunId &&
          event.status === 'failed',
      ),
    )

    expect(
      events.filter(
        ({ event }) =>
          (event.type === 'tool.proposed' ||
            event.type === 'approval.requested') &&
          event.runId === rejectedRunId,
      ),
    ).toEqual([])
    expect(
      committedHistories
        .flat()
        .filter((record) => record.kind === 'assistant_turn'),
    ).toEqual([])

    const validRunId = manager.startRun({
      sessionId,
      message: 'Answer without tools',
      clientRequestId: 'request:valid-provider',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === validRunId &&
          event.status === 'completed',
      ),
    )

    expect(
      committedHistories
        .at(-1)
        ?.filter((record) => record.kind === 'assistant_turn'),
    ).toHaveLength(1)
    expect(provider.calls).toBe(2)
    await manager.closeSession(sessionId)
  })

  it('rejects a call id reused across turns before executing it again', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-cross-turn-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), 'fixture')
    const events: AgentEventEnvelope[] = []
    const committedHistories: SessionState['history'][] = []
    const provider = new CrossTurnDuplicateProvider()
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => provider,
      executionState: {
        commit: async (session) => {
          committedHistories.push(structuredClone(session.history))
          return undefined
        },
      },
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const rejectedRunId = manager.startRun({
      sessionId,
      message: 'Read with a duplicated continuation id',
      clientRequestId: 'request:cross-turn-duplicate',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === rejectedRunId &&
          event.status === 'failed',
      ),
    )

    expect(
      events.filter(
        ({ event }) =>
          event.type === 'tool.proposed' &&
          event.runId === rejectedRunId &&
          event.callId === 'call:reused-across-turns',
      ),
    ).toHaveLength(1)
    expect(
      committedHistories
        .at(-1)
        ?.filter(
          (record) =>
            record.kind === 'assistant_turn' &&
            record.parts.some(
              (part) =>
                part.type === 'tool_call' &&
                part.callId === 'call:reused-across-turns',
            ),
        ),
    ).toHaveLength(1)

    const validRunId = manager.startRun({
      sessionId,
      message: 'Continue safely',
      clientRequestId: 'request:after-cross-turn-duplicate',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === validRunId &&
          event.status === 'completed',
      ),
    )
    expect(provider.calls).toBe(3)
    await manager.closeSession(sessionId)
  })

  it('retries a transient partial stream without retaining its live output', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-retry-stream-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const events: AgentEventEnvelope[] = []
    const committedHistories: SessionState['history'][] = []
    const provider = new PartialFailureThenValidProvider()
    const configStore = await createConfig(directory)
    await configStore.update({
      version: 1,
      kind: 'logging',
      value: {
        ...configStore.getPublicConfig().logging,
        trace: {
          ...configStore.getPublicConfig().logging.trace,
          enabled: true,
        },
      },
    })
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => provider,
      executionState: {
        commit: async (session) => {
          committedHistories.push(structuredClone(session.history))
          return undefined
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
      message: 'Recover this request',
      clientRequestId: 'request:provider-auto-retry',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(2)
    const retryReset = events.findIndex(
      ({ event }) =>
        event.type === 'assistant.stream.reset' && event.runId === runId,
    )
    const discardedDelta = events.findIndex(
      ({ event }) =>
        event.type === 'assistant.text.delta' &&
        event.runId === runId &&
        event.delta === 'Discarded partial answer',
    )
    const recovered = events.findIndex(
      ({ event }) =>
        event.type === 'assistant.message.completed' &&
        event.runId === runId &&
        event.text === 'Recovered answer',
    )
    expect(discardedDelta).toBeGreaterThan(-1)
    expect(retryReset).toBeGreaterThan(discardedDelta)
    expect(recovered).toBeGreaterThan(retryReset)
    expect(
      committedHistories
        .flat()
        .filter((record) => record.kind === 'assistant_turn')
        .flatMap((record) =>
          record.kind === 'assistant_turn'
            ? record.parts.flatMap((part) =>
                part.type === 'text' ? [part.text] : [],
              )
            : [],
        ),
    ).toEqual(['Recovered answer'])
    await manager.closeSession(sessionId)
    const traceEvents = parseTrace(await readSessionTrace(directory, sessionId))
    expect(
      traceEvents.filter((event) => event.type === 'llm.request'),
    ).toHaveLength(2)
    expect(
      traceEvents.filter((event) => event.type === 'llm.failure'),
    ).toHaveLength(1)
    expect(
      traceEvents.filter((event) => event.type === 'llm.response'),
    ).toHaveLength(1)
  })

  it('reports a reasoning-only completion as a retryable run failure', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-reasoning-only-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const events: AgentEventEnvelope[] = []
    const operationalEvents: Array<
      OperationalEventInput & { diagnosticId?: DiagnosticId }
    > = []
    let diagnosticSequence = 0
    const operationalLog = {
      log(input: OperationalEventInput) {
        const diagnosticId =
          input.diagnosticId ??
          (input.level === 'warn' || input.level === 'error'
            ? (`diagnostic:test-${++diagnosticSequence}` as DiagnosticId)
            : undefined)
        operationalEvents.push({
          ...structuredClone(input),
          ...(diagnosticId ? { diagnosticId } : {}),
        })
        return {
          eventId: `event:test-${operationalEvents.length}` as EventId,
          diagnosticId,
          written: true,
        }
      },
    }
    const configStore = await createConfig(directory)
    await configStore.update({
      version: 1,
      kind: 'logging',
      value: {
        ...configStore.getPublicConfig().logging,
        trace: {
          ...configStore.getPublicConfig().logging.trace,
          enabled: true,
        },
      },
    })
    const provider = new ReasoningOnlyProvider()
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => provider,
      operationalLog,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    const runId = manager.startRun({
      sessionId,
      message: 'Finish the answer',
      clientRequestId: 'request:reasoning-only',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      ),
    )

    expect(
      events.find(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      )?.event,
    ).toMatchObject({
      error: {
        code: 'PROVIDER_COMPLETION_INVALID',
        message:
          'Provider returned reasoning without an assistant answer; retry the request',
      },
    })
    await manager.closeSession(sessionId)
    const traceText = await readSessionTrace(directory, sessionId)
    const traceEvents = parseTrace(traceText)
    const failures = traceEvents.filter((event) => event.type === 'llm.failure')
    const response = failures[0]
    expect(provider.calls).toBe(2)
    expect(failures).toHaveLength(2)
    expect(traceEvents.some((event) => event.type === 'llm.stream')).toBe(false)
    expect(traceText).not.toContain('Unfinished reasoning')
    expect(response).toMatchObject({
      operation: 'main',
      stage: 'completion',
      code: 'PROVIDER_COMPLETION_INVALID',
      timing: { ttftMs: null, totalMs: 0, responseBytes: 0 },
      evidence: {
        kind: 'invalid_completion',
        content: '{"id":"reasoning-only"}',
        truncated: false,
      },
    })
    const providerFailures = operationalEvents.filter(
      (event) => event.event === 'provider.failed',
    )
    const providerFailure = providerFailures.at(-1)
    const runFailure = operationalEvents.find(
      (event) => event.event === 'run.failed',
    )
    const runStatus = events.find(
      ({ event }) =>
        event.type === 'run.status' &&
        event.runId === runId &&
        event.status === 'failed',
    )?.event
    expect(providerFailures.map((event) => event.attempt)).toEqual([1, 2])
    expect(providerFailure?.diagnosticId).toBeTruthy()
    expect(runFailure?.diagnosticId).toBe(providerFailure?.diagnosticId)
    expect(
      runStatus?.type === 'run.status'
        ? runStatus.error?.diagnosticId
        : undefined,
    ).toBe(providerFailure?.diagnosticId)
  })

  it('retains the original validation error and trace for a malformed turn', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-malformed-turn-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const events: AgentEventEnvelope[] = []
    const configStore = await createConfig(directory)
    await configStore.update({
      version: 1,
      kind: 'logging',
      value: {
        ...configStore.getPublicConfig().logging,
        trace: {
          ...configStore.getPublicConfig().logging.trace,
          enabled: true,
        },
      },
    })
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => new MissingUsageProvider(),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Return a malformed completion',
      clientRequestId: 'request:malformed-turn',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      ),
    )

    expect(
      events.find(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'failed',
      )?.event,
    ).toMatchObject({
      error: {
        message: 'Provider completion is missing canonical fields',
      },
    })
    await manager.closeSession(sessionId)
    expect(
      parseTrace(await readSessionTrace(directory, sessionId)).find(
        (event) => event.type === 'llm.failure',
      ),
    ).toMatchObject({
      operation: 'main',
      stage: 'validation',
      code: 'PROVIDER_COMPLETION_INVALID',
      evidence: {
        kind: 'invalid_completion',
        content: '{"id":"missing-usage"}',
        truncated: false,
      },
    })
  })
})
