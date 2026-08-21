import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { ProjectId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  AbortCompactProvider,
  AutoCompactProvider,
  CompactProvider,
  ContextLimitProvider,
  InterjectedAutoCompactProvider,
  ToolBatchAutoCompactProvider,
} from './session-manager-compaction-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

/** Selects the exact main route used by compaction threshold fixtures. */
async function selectCompactionModel(
  store: Awaited<ReturnType<typeof createConfig>>,
  model: string,
): Promise<void> {
  const roles = store.getPublicConfig().models
  await store.update({
    version: 1,
    kind: 'models',
    value: {
      defaultModelProvider: roles.defaultModelProvider,
      defaultModel: model,
      defaultModelReasoning: 'off',
      auxiliaryModelProvider: roles.auxiliaryModelProvider,
      auxiliaryModel: roles.auxiliaryModel,
      auxiliaryModelReasoning: roles.auxiliaryModelReasoning,
    },
  })
}

describe('SessionManager compaction', () => {
  it('orders manual /compact follow-up after the compact summary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new CompactProvider()
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
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'RAW_SHOULD_DROP first task',
      clientRequestId: 'request-before-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 1,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    manager.startRun({
      sessionId,
      message: '/compact focus on risks',
      clientRequestId: 'request-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 2,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      sent.find((envelope) => envelope.event.type === 'orchestrator.message')
        ?.event,
    ).toMatchObject({
      type: 'orchestrator.message',
      kind: 'compact',
      promptId: 'orchestration.compact.zh-CN',
    })
    expect(provider.requests[1]?.tools).toEqual([])
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
      'focus on risks',
    )

    const compactContinuation = provider.requests[2]?.messages ?? []
    const compactSummaryIndex = compactContinuation.findIndex(
      (message) =>
        message.role === 'user' &&
        String(message.content ?? '').includes('<compact_history'),
    )
    const newUserIndex = compactContinuation.findIndex(
      (message) => message.content === 'focus on risks',
    )
    expect(JSON.stringify(compactContinuation)).not.toContain('RAW_SHOULD_DROP')
    expect(compactContinuation[0]?.role).toBe('system')
    expect(compactSummaryIndex).toBeGreaterThan(0)
    expect(newUserIndex).toBeGreaterThan(compactSummaryIndex)

    manager.startRun({
      sessionId,
      message: 'continue after compact',
      clientRequestId: 'request-after-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 3,
    )

    const afterCompactMessages = provider.requests[3]?.messages ?? []
    const rendered = JSON.stringify(afterCompactMessages)

    expect(rendered).not.toContain('RAW_SHOULD_DROP')
    expect(afterCompactMessages[0]?.role).toBe('system')
    expect(rendered).toContain('<compact_history')
    expect(rendered).toContain('Compact summary retained')
    expect(rendered).toContain('Orchestration state at compaction:')
    expect(
      afterCompactMessages.some(
        (message) => message.content === 'continue after compact',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('ends pure /compact after rebuilding system, harness, and summary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new CompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'history to summarize',
      clientRequestId: 'pure-before',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 1,
    )

    manager.startRun({
      sessionId,
      message: '/compact',
      clientRequestId: 'pure-compact',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
    )

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.tools).toEqual([])
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'assistant.message.completed' &&
          event.text === 'Compact summary retained',
      ),
    ).toBe(true)

    manager.startRun({
      sessionId,
      message: 'new task',
      clientRequestId: 'pure-after',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 3,
    )
    const messages = provider.requests[2]?.messages ?? []
    const summaryIndex = messages.findIndex((message) =>
      String(message.content ?? '').includes('<compact_history'),
    )
    const userIndex = messages.findIndex(
      (message) => message.content === 'new task',
    )
    expect(messages[0]?.role).toBe('system')
    expect(summaryIndex).toBeGreaterThan(0)
    expect(userIndex).toBeGreaterThan(summaryIndex)
    expect(JSON.stringify(messages)).not.toContain('history to summarize')
    await manager.closeSession(sessionId)
  })

  it('supports repeated compaction without reviving an older epoch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const provider = new CompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    for (const [message, clientRequestId] of [
      ['history before repeated compact', 'repeat-before'],
      ['/compact', 'repeat-first'],
      ['/compact', 'repeat-second'],
      ['continue from latest checkpoint', 'repeat-after'],
    ] as const) {
      const runId = manager.startRun({ sessionId, message, clientRequestId })
      const expectedCompleted =
        clientRequestId === 'repeat-before'
          ? 1
          : clientRequestId === 'repeat-first'
            ? 2
            : clientRequestId === 'repeat-second'
              ? 3
              : 4
      await waitFor(
        () =>
          sent.filter(
            ({ event }) =>
              event.type === 'run.status' && event.status === 'completed',
          ).length >= expectedCompleted,
      )
      await manager.waitForRunSettled(sessionId, runId)
    }

    const latest = provider.requests[3]?.messages ?? []
    expect(
      latest.filter((message) =>
        String(message.content ?? '').includes('<compact_history'),
      ),
    ).toHaveLength(1)
    expect(JSON.stringify(latest)).not.toContain(
      'history before repeated compact',
    )
    expect(JSON.stringify(latest)).toContain('continue from latest checkpoint')
    await manager.closeSession(sessionId)
  })

  it('rolls back manual compaction when its Provider stream is aborted', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const provider = new AbortCompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'history survives aborted compact',
      clientRequestId: 'abort-before',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' && event.status === 'completed',
      ),
    )

    const compactRunId = manager.startRun({
      sessionId,
      message: '/compact',
      clientRequestId: 'abort-compact',
    })
    await provider.compactStarted.promise
    expect(manager.interruptRun(sessionId, compactRunId)).toBe(true)
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === compactRunId &&
          event.status === 'cancelled',
      ),
    )
    await manager.waitForRunSettled(sessionId, compactRunId)

    manager.startRun({
      sessionId,
      message: 'continue after aborted compact',
      clientRequestId: 'abort-after',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
    )

    const latest = provider.requests[2] ?? []
    expect(JSON.stringify(latest)).toContain('history survives aborted compact')
    expect(JSON.stringify(latest)).not.toContain('<compact_history')
    await manager.closeSession(sessionId)
  })

  it('auto compacts older history when the prompt reaches the configured threshold', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-auto-compact-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'auto-compact-test-model',
      contextWindowTokens: 160_000,
      compactThresholdTokens: 1_024,
      maxOutputTokens: 8_000,
      limits: {
        ...current.limits,
        autoCompactTriggerPercent: 95,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
      },
    })
    await selectCompactionModel(store, 'auto-compact-test-model')
    const provider = new AutoCompactProvider()
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
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: `AUTO_OLD_CONTEXT ${'x'.repeat(10_000)}`,
      clientRequestId: 'request-auto-compact-old',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            ['completed', 'failed', 'cancelled'].includes(
              envelope.event.status,
            ),
        ).length >= 1,
      5_000,
    )
    const firstTerminal = sent.find(
      (envelope) =>
        envelope.event.type === 'run.status' &&
        ['completed', 'failed', 'cancelled'].includes(envelope.event.status),
    )?.event
    expect(
      firstTerminal?.type === 'run.status' ? firstTerminal.status : undefined,
      JSON.stringify(firstTerminal),
    ).toBe('completed')
    await new Promise((resolve) => setTimeout(resolve, 20))

    manager.startRun({
      sessionId,
      message: 'AUTO_CURRENT_TURN must remain',
      clientRequestId: 'request-auto-compact-current',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 2,
      5_000,
    )

    expect(provider.requests[1]?.tools).toEqual([])
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'compact-auto',
      ),
    ).toBe(true)

    const afterAutoCompactMessages = provider.requests[2]?.messages ?? []
    const rendered = JSON.stringify(afterAutoCompactMessages)

    expect(rendered).not.toContain('AUTO_OLD_CONTEXT')
    expect(rendered).toContain('AUTO_CURRENT_TURN must remain')
    expect(afterAutoCompactMessages[0]?.role).toBe('system')
    const replayedRootIndex = afterAutoCompactMessages.findIndex(
      (message) => message.content === 'AUTO_CURRENT_TURN must remain',
    )
    const summaryIndex = afterAutoCompactMessages.findIndex(
      (message) =>
        message.role === 'user' &&
        String(message.content ?? '').includes('<compact_history'),
    )
    expect(summaryIndex).toBeGreaterThan(0)
    expect(replayedRootIndex).toBeGreaterThan(summaryIndex)
    expect(replayedRootIndex, rendered).toBe(
      afterAutoCompactMessages.length - 1,
    )
    expect(afterAutoCompactMessages[summaryIndex]?.content).toContain(
      'Auto compact summary retained',
    )
    await manager.closeSession(sessionId)
  }, 20_000)

  it('does not compact a harness run from local size estimates alone', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-harness-compact-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'limits',
      value: {
        ...current.limits,
        autoCompactTriggerPercent: 1,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
      },
    })
    const provider = new AutoCompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startHarnessRun({
      sessionId,
      clientRequestId: 'harness-compact',
      message: {
        kind: 'test_followup',
        text: `HARNESS_ONLY ${'x'.repeat(10_000)}`,
        source: 'test:harness',
      },
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 1,
      5_000,
    )

    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.tools.length).toBeGreaterThan(0)
    const request = provider.requests[0]?.messages ?? []
    const harnessIndex = request.findIndex((message) =>
      String(message.content ?? '').includes('HARNESS_ONLY'),
    )
    expect(harnessIndex).toBeGreaterThan(0)
    expect(
      request.some((message) =>
        String(message.content ?? '').includes('<compact_history'),
      ),
    ).toBe(false)
    await manager.closeSession(sessionId)
  }, 30_000)

  it('compacts only after a threshold-crossing tool result is committed', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-tool-result-compact-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(
      path.join(workspace, 'README.md'),
      'TOOL_RESULT_BEFORE_COMPACT',
      'utf8',
    )
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'tool-result-compact-model',
      contextWindowTokens: 160_000,
      compactThresholdTokens: 1_024,
      maxOutputTokens: 8_000,
      limits: current.limits,
    })
    await selectCompactionModel(store, 'tool-result-compact-model')
    const provider = new ToolBatchAutoCompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Read the fixture before continuing.',
      clientRequestId: 'request:tool-result-compact',
    })

    await waitFor(
      () =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ),
      5_000,
    )

    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[0]?.tools.length).toBeGreaterThan(0)
    expect(provider.requests[1]?.tools).toEqual([])
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      'TOOL_RESULT_BEFORE_COMPACT',
    )
    expect(JSON.stringify(provider.requests[2]?.messages)).not.toContain(
      'TOOL_RESULT_BEFORE_COMPACT',
    )
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain(
      'Tool result checkpoint retained',
    )
    const continued = JSON.stringify(provider.requests[2]?.messages)
    expect(continued).not.toContain('<todo_state')
    expect(continued).toContain('Finish after compact')
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'todo.updated' &&
          event.todo.items[0]?.step === 'Read the fixture',
      ),
    ).toBe(true)

    manager.startRun({
      sessionId,
      message: 'Start a separate task.',
      clientRequestId: 'request:after-todo-run',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
      5_000,
    )

    const nextRunContext = JSON.stringify(provider.requests[3]?.messages)
    expect(nextRunContext).not.toContain('<todo_state')
    expect(nextRunContext).toContain('Finish after compact')
    await manager.closeSession(sessionId)
  }, 30_000)

  it('replaces incompatible model history with a transcript before new user input', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-model-transition-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'transition-model-a',
      enabledModelIds: [
        'deepseek-v4-pro',
        'transition-model-a',
        'transition-model-b',
      ],
      limits: current.limits,
    })
    const provider = new CompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
      modelSelection: {
        providerId: 'deepseek',
        model: 'transition-model-a',
        reasoning: 'off',
      },
    })
    manager.startRun({
      sessionId,
      message: 'MODEL_A_PRIVATE_TURN',
      clientRequestId: 'request:model-a',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 1,
    )
    await waitFor(() => !manager.hasActiveRun(sessionId))

    const timestamp = '2026-08-08T00:00:00.000Z'
    const durableRecord: SessionRecord = {
      schemaVersion: 1,
      id: sessionId,
      projectId: 'project:model-transition' as ProjectId,
      title: 'Model transition fixture',
      titleSource: 'user',
      lifecycle: 'active',
      permissionMode: 'readonly',
      modelSelection: {
        providerId: 'deepseek',
        model: 'transition-model-b',
        reasoning: 'off',
      },
      goal: null,
      plan: null,
      revision: 2,
      lastSeq: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    manager.applyDurableSessionRecord(durableRecord)
    manager.startRun({
      sessionId,
      message: 'MODEL_B_CURRENT_TURN',
      clientRequestId: 'request:model-b',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
      5_000,
    )

    expect(provider.requests).toHaveLength(2)
    const transitioned = provider.requests[1]?.messages ?? []
    const transcriptIndex = transitioned.findIndex(
      (message) =>
        message.role === 'user' &&
        String(message.content ?? '').startsWith(
          '<conversation_transcript format=',
        ),
    )
    const currentUserIndex = transitioned.findIndex(
      (message) => message.content === 'MODEL_B_CURRENT_TURN',
    )
    expect(transcriptIndex).toBeGreaterThan(0)
    expect(currentUserIndex).toBeGreaterThan(transcriptIndex)
    expect(transitioned[currentUserIndex]).toBe(transitioned.at(-1))
    expect(String(transitioned[transcriptIndex]?.content)).toContain(
      'MODEL_A_PRIVATE_TURN',
    )
    expect(String(transitioned[transcriptIndex]?.content)).toContain(
      'Old answer',
    )
    expect(transitioned.some((message) => message.role === 'assistant')).toBe(
      false,
    )
    await manager.closeSession(sessionId)
  }, 30_000)

  it('keeps the old epoch active when durable transcript loading fails', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-model-transition-rollback-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'rollback-model-a',
      enabledModelIds: [
        'deepseek-v4-pro',
        'rollback-model-a',
        'rollback-model-b',
      ],
      limits: current.limits,
    })
    const provider = new CompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      historySource: {
        async listAllMessages() {
          throw new Error('durable history unavailable')
        },
      },
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
      modelSelection: {
        providerId: 'deepseek',
        model: 'rollback-model-a',
        reasoning: 'off',
      },
    })
    manager.startRun({
      sessionId,
      message: 'SURVIVES_FAILED_TRANSITION',
      clientRequestId: 'request:rollback-a',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' && event.status === 'completed',
      ),
    )
    await waitFor(() => !manager.hasActiveRun(sessionId))

    const timestamp = '2026-08-08T00:00:00.000Z'
    const sessionRecord = (model: string, revision: number): SessionRecord => ({
      schemaVersion: 1,
      id: sessionId,
      projectId: 'project:model-transition-rollback' as ProjectId,
      title: 'Model transition rollback fixture',
      titleSource: 'user',
      lifecycle: 'active',
      permissionMode: 'readonly',
      modelSelection: {
        providerId: 'deepseek',
        model,
        reasoning: 'off',
      },
      goal: null,
      plan: null,
      revision,
      lastSeq: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    manager.applyDurableSessionRecord(sessionRecord('rollback-model-b', 2))
    const failedRunId = manager.startRun({
      sessionId,
      message: 'MUST_NOT_BE_INSERTED',
      clientRequestId: 'request:rollback-b',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === failedRunId &&
          event.status === 'failed',
      ),
    )
    await waitFor(() => !manager.hasActiveRun(sessionId))
    expect(provider.requests).toHaveLength(1)

    manager.applyDurableSessionRecord(sessionRecord('rollback-model-a', 3))
    const recoveredRunId = manager.startRun({
      sessionId,
      message: 'CONTINUE_OLD_MODEL',
      clientRequestId: 'request:rollback-recovered',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === recoveredRunId &&
          event.status === 'completed',
      ),
    )

    const recovered = JSON.stringify(provider.requests[1]?.messages)
    expect(recovered).toContain('SURVIVES_FAILED_TRANSITION')
    expect(recovered).toContain('Old answer')
    expect(recovered).toContain('CONTINUE_OLD_MODEL')
    expect(recovered).not.toContain('MUST_NOT_BE_INSERTED')
    expect(recovered).not.toContain('<conversation_transcript format=')
    await manager.closeSession(sessionId)
  }, 30_000)

  it('accepts a Provider response at the configured limit and defers compaction', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-context-limit-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      contextWindowTokens: 160_000,
      compactThresholdTokens: 100_000,
      maxOutputTokens: 8_000,
      limits: current.limits,
    })
    const provider = new ContextLimitProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Reach the reported context limit.',
      clientRequestId: 'request:context-limit',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === runId &&
          event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(1)
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'assistant.message.completed' &&
          event.runId === runId &&
          event.text === 'Response at the context limit',
      ),
    ).toBe(true)
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'orchestrator.message' &&
          event.kind === 'compact-auto',
      ),
    ).toBe(false)

    const nextRunId = manager.startRun({
      sessionId,
      message: 'Continue after the accepted response.',
      clientRequestId: 'request:context-limit-next',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === nextRunId &&
          event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(3)
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'orchestrator.message' &&
          event.kind === 'compact-auto',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  }, 30_000)

  it('drains an interjection that arrives while auto compact is streaming', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interjected-compact-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'interjection-compact-test-model',
      contextWindowTokens: 160_000,
      compactThresholdTokens: 1_024,
      maxOutputTokens: 8_000,
      limits: {
        ...current.limits,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
      },
    })
    await selectCompactionModel(store, 'interjection-compact-test-model')
    const provider = new InterjectedAutoCompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'OLDER_CONTEXT_BEFORE_DEFERRED_COMPACT',
      clientRequestId: 'interjected-compact-old',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' && event.status === 'completed',
      ),
    )

    const runId = manager.startRun({
      sessionId,
      message: `ROOT_DURING_COMPACT ${'x'.repeat(10_000)}`,
      clientRequestId: 'interjected-compact-root',
    })

    await provider.compactStarted.promise
    expect(
      manager.interjectRun({
        sessionId,
        runId,
        message: 'LATEST_DURING_COMPACT',
        clientRequestId: 'interjected-compact-live',
      }),
    ).toBe(true)
    provider.releaseCompact.resolve()
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
      5_000,
    )

    const continuation = provider.requests[2] ?? []
    const rootIndex = continuation.findIndex(
      (message) =>
        message.content === `ROOT_DURING_COMPACT ${'x'.repeat(10_000)}`,
    )
    const summaryIndex = continuation.findIndex((message) =>
      String(message.content ?? '').includes('<compact_history'),
    )
    const interjectionIndex = continuation.findIndex((message) =>
      String(message.content ?? '').includes('LATEST_DURING_COMPACT'),
    )
    expect(summaryIndex).toBeGreaterThan(0)
    expect(rootIndex).toBeGreaterThan(summaryIndex)
    expect(interjectionIndex).toBeGreaterThan(summaryIndex)
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'interjection.updated' && event.status === 'injected',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  }, 30_000)
})
