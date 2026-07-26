import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  AbortCompactProvider,
  AutoCompactProvider,
  CompactProvider,
  InterjectedAutoCompactProvider,
} from './session-manager-compaction-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

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
    expect(rendered).toContain('Goal: none')
    expect(rendered).toContain('Plan: none')
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
      reasoning: 'off',
      contextWindowTokens: 160_000,
      maxOutputTokens: 8_000,
      approverProviderId: 'deepseek',
      approverModel: 'deepseek-v4-flash',
      limits: {
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

    expect(provider.requests[2]?.tools).toEqual([])
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'compact-auto',
      ),
    ).toBe(true)

    const afterAutoCompactMessages = provider.requests[3]?.messages ?? []
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
    expect(replayedRootIndex).toBeGreaterThan(0)
    expect(summaryIndex).toBeGreaterThan(replayedRootIndex)
    expect(summaryIndex, rendered).toBe(afterAutoCompactMessages.length - 1)
    expect(afterAutoCompactMessages[summaryIndex]?.content).toContain(
      'Auto compact summary retained',
    )
    await manager.closeSession(sessionId)
  }, 20_000)

  it('omits root user replay for a harness-driven automatic compact', async () => {
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
        kind: 'benchmark_feedback',
        text: `HARNESS_ONLY ${'x'.repeat(10_000)}`,
        source: 'test:harness',
      },
    })
    await waitFor(
      () =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ),
      5_000,
    )

    expect(provider.requests[0]?.tools).toEqual([])
    const continuation = provider.requests[1]?.messages ?? []
    expect(continuation.at(-1)?.role).toBe('user')
    expect(continuation.at(-1)?.content).toContain('<compact_history')
    const harnessIndex = continuation.findIndex((message) =>
      String(message.content ?? '').includes('HARNESS_ONLY'),
    )
    expect(harnessIndex).toBeGreaterThan(0)
    expect(harnessIndex).toBeLessThan(continuation.length - 1)
    expect(
      continuation.some((message) =>
        String(message.content ?? '').includes('<user_input'),
      ),
    ).toBe(false)
    await manager.closeSession(sessionId)
  }, 10_000)

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
      kind: 'limits',
      value: {
        ...current.limits,
        autoCompactTriggerPercent: 1,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
      },
    })
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
        sent.some(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ),
      5_000,
    )

    const continuation = provider.requests[1] ?? []
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
    expect(rootIndex).toBeGreaterThan(0)
    expect(summaryIndex).toBeGreaterThan(rootIndex)
    expect(interjectionIndex).toBeGreaterThan(summaryIndex)
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'interjection.updated' && event.status === 'injected',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  }, 10_000)
})
