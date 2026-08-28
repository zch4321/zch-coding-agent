import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type {
  AgentExecutionId,
  CallId,
  MessageId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import { DEFAULT_HARNESS_PROMPT_REFS } from '../../shared/prompt-resources'
import { PromptRegistry } from '../prompts/registry'
import { PluginEventBus } from '../plugins/event-bus'
import { resolveModelRoutePairFromConfig } from '../providers/model-route-resolver'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import {
  swarmSharedContextContent,
  swarmTaskContent,
} from '../subagent/assignment-prompt'
import { SessionManager } from './session-manager'
import {
  PromptAuditProvider,
  ScriptedProvider,
} from './session-manager-prompt-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  ForkProvider,
  parseTrace,
  readSessionTrace,
  waitFor,
} from './session-manager-test-support'
import type { SessionExecutionStatePort } from './session-types'

/** Simulates workspace changes between Provider calls and across Run boundaries. */
class PromptContextBoundaryProvider extends ScriptedProviderHarness {
  calls = 0
  readonly requests: ProviderStreamRequest['normalizedMessages'][] = []

  /** Creates a Provider fixture bound to the test workspace. */
  constructor(private readonly workspace: string) {
    super()
  }

  /** Records each request and forces one two-step Provider loop. */
  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      await writeFile(
        path.join(this.workspace, 'AGENTS.md'),
        'Updated during the active Run\n',
      )
      await writeFile(
        path.join(this.workspace, 'generated-file.txt'),
        'generated\n',
      )
      const toolCall = {
        id: 'call-boundary-read',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: 'README.md' }),
        },
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'boundary-tool' },
        turn: { role: 'assistant', content: null, tool_calls: [toolCall] },
        toolCalls: [
          {
            id: toolCall.id as CallId,
            toolId: 'read_file',
            args: { path: 'README.md' },
            reason: 'Force another Provider call in the same Run',
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
      rawResponse: { id: `boundary-final-${this.calls}` },
      turn: { role: 'assistant', content: `Boundary call ${this.calls}` },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

describe('SessionManager prompt and trace', () => {
  it('rejects an unknown provider instead of falling back to the active one', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-provider-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink(() => undefined),
    })

    await expect(
      manager.createSession({
        workspace,
        mode: 'readonly',
        provider: 'missing-provider',
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'PRECONDITION_FAILED',
        message: 'Provider is not configured: missing-provider',
      },
    })
  })

  it('uses configurable assistant preferences without replacing the base harness system message', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-prompt-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'assistant',
      value: {
        language: 'en-US',
        preferences: {
          'zh-CN': '中文偏好',
          'en-US': 'English assistant preference selected by the test',
        },
      },
    })
    const provider = new ForkProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
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
      message: 'hello',
      clientRequestId: 'prompt-request',
    })

    await waitFor(
      () =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            ['completed', 'failed', 'cancelled'].includes(event.status),
        ),
      5_000,
    )
    const terminalEvent = sent.find(
      ({ event }) =>
        event.type === 'run.status' &&
        ['completed', 'failed', 'cancelled'].includes(event.status),
    )?.event
    expect(
      terminalEvent?.type === 'run.status' ? terminalEvent.status : undefined,
      JSON.stringify(terminalEvent),
    ).toBe('completed')
    expect(provider.messages[0]?.role).toBe('system')
    expect(provider.messages[1]?.role).toBe('user')
    expect(provider.messages[1]?.content).toContain('<environment_context')
    expect(
      provider.messages.some((message) => message.content === 'hello'),
    ).toBe(true)
    expect(
      provider.messages.some(
        (message) =>
          message.role === 'user' &&
          String(message.content ?? '').includes(
            'English assistant preference selected by the test',
          ),
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('refreshes runtime and AGENTS context once per external Run', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-prompt-run-boundary-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), '# Boundary\n')
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Initial Run guidance\n')
    const store = await createConfig(directory)
    const provider = new PromptContextBoundaryProvider(workspace)
    const sent: AgentEventEnvelope[] = []
    let originalUserMessageId: MessageId | undefined
    const executionState: SessionExecutionStatePort = {
      async commit(session, input) {
        if (input.reason === 'run_input' && !originalUserMessageId) {
          originalUserMessageId = session.history.find(
            (record) => record.kind === 'user_input',
          )?.id
        }
      },
    }
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
      executionState,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const firstRunId = manager.startRun({
      sessionId,
      message: 'Exercise the Provider loop',
      clientRequestId: 'request-context-boundary-first',
    })

    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === firstRunId &&
          event.status === 'completed',
      ),
    )
    expect(originalUserMessageId).toBeDefined()
    expect(provider.requests).toHaveLength(2)
    const secondCall = provider.requests[1] ?? []
    expect(
      secondCall.filter(
        (message) =>
          message.role === 'user' &&
          String(message.content ?? '').startsWith('<environment_context'),
      ),
    ).toHaveLength(1)
    expect(JSON.stringify(secondCall)).toContain('Initial Run guidance')
    expect(JSON.stringify(secondCall)).not.toContain(
      'Updated during the active Run',
    )
    expect(JSON.stringify(secondCall)).not.toContain('generated-file.txt')

    const retryRunId = manager.retryRun({
      sessionId,
      userMessageId: originalUserMessageId!,
      clientRequestId: 'request-context-boundary-retry',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === retryRunId &&
          event.status === 'completed',
      ),
    )
    expect(JSON.stringify(provider.requests[2])).toContain(
      'Updated during the active Run',
    )
    expect(
      (provider.requests[2] ?? []).filter(
        (message) =>
          message.role === 'user' &&
          String(message.content ?? '').startsWith('<environment_context'),
      ),
    ).toHaveLength(1)

    await writeFile(
      path.join(workspace, 'AGENTS.md'),
      'Updated before a new user Run\n',
    )
    const userRunId = manager.startRun({
      sessionId,
      message: 'Start another user Run',
      clientRequestId: 'request-context-boundary-user',
    })
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === userRunId &&
          event.status === 'completed',
      ),
    )
    expect(JSON.stringify(provider.requests[3])).toContain(
      'Updated before a new user Run',
    )
    await manager.closeSession(sessionId)
  })

  it('stores Swarm shared context separately from the tagged child task', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-swarm-prompt-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const config = store.getPublicConfig()
    const providerConfig = config.models.providers[0]!
    const modelSelection = {
      providerId: providerConfig.id,
      model: providerConfig.model,
      reasoning: config.models.defaultModelReasoning,
    }
    const routes = await resolveModelRoutePairFromConfig(
      store,
      config,
      modelSelection,
    )
    const provider = new ForkProvider()
    let committedHistory: MessageRecord[] = []
    const executionState: SessionExecutionStatePort = {
      async commit(session, input) {
        if (input.reason === 'run_input') {
          committedHistory = structuredClone(session.history)
        }
        return undefined
      },
    }
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => provider,
      executionState,
    })
    const sessionId = 'session:swarm-tagged-child' as SessionId
    await manager.createInternalSession({
      sessionId,
      workspace,
      mode: 'readonly',
      provider: providerConfig.id,
      modelSelection,
      allowedToolIds: new Set(),
      gitToolsEnabled: true,
      providerSnapshot: providerConfig,
      execution: {
        executionId: 'execution:swarm-tagged-child' as AgentExecutionId,
        parentSessionId: 'session:swarm-parent' as SessionId,
        parentRunId: 'run:swarm-parent' as RunId,
        parentCallId: 'call:swarm-parent' as CallId,
        name: 'swarm-tagged-child',
        createdAt: '2026-08-12T00:00:00.000Z',
      },
    })
    const sharedContext = swarmSharedContextContent(
      'npm run check exited 0 <stable>',
    )
    const task = swarmTaskContent('Review <session> & report')
    const run = manager.startInternalRun({
      sessionId,
      task,
      context: {
        content: sharedContext,
        source: 'swarm:shared-context',
      },
      clientRequestId: 'request:swarm-tagged-child',
      routes,
    })

    await expect(run.completion).resolves.toMatchObject({
      status: 'completed',
      response: 'Fork complete',
    })
    const contextRecord = committedHistory.find(
      (record) =>
        record.kind === 'selected_context' &&
        record.metadata?.layer.source === 'swarm:shared-context',
    )
    const taskRecord = committedHistory.find(
      (record) => record.kind === 'user_input',
    )
    expect(contextRecord?.parts).toEqual([
      { type: 'text', text: sharedContext },
    ])
    expect(taskRecord?.parts).toEqual([{ type: 'text', text: task }])
    expect(contextRecord?.turnId).toBe(taskRecord?.id)
    expect(
      provider.messages.some((message) => message.content === sharedContext),
    ).toBe(true)
    expect(provider.messages.some((message) => message.content === task)).toBe(
      true,
    )
    await manager.closeSession(sessionId)
  })

  it('runs a deterministic read-only README summary and keeps credentials out of trace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), '# Project\nhello\n')

    const store = await createConfig(directory)
    const provider = new ScriptedProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    }
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
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Read README and summarize it',
      clientRequestId: 'request-1',
    })

    await waitFor(
      () =>
        sent.some(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            ['completed', 'failed', 'cancelled'].includes(
              envelope.event.status,
            ),
        ),
      5_000,
    )
    const terminalEvent = sent.find(
      (envelope) =>
        envelope.event.type === 'run.status' &&
        ['completed', 'failed', 'cancelled'].includes(envelope.event.status),
    )?.event
    expect(
      terminalEvent?.type === 'run.status' ? terminalEvent.status : undefined,
      JSON.stringify(terminalEvent),
    ).toBe('completed')

    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'tool.completed' &&
          envelope.event.result.status === 'ok',
      ),
    ).toBe(true)
    const activities = sent.flatMap(({ event }) =>
      event.type === 'assistant.activity' ? [event] : [],
    )
    expect(activities.map((event) => event.activity)).toEqual([
      'reasoning',
      'tool_call',
      'output',
    ])
    expect(activities).toEqual(
      activities.map((event) => ({
        schemaVersion: 1,
        type: 'assistant.activity',
        sessionId,
        runId: event.runId,
        activity: event.activity,
        seq: event.seq,
        ts: event.ts,
      })),
    )
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.text.delta' &&
          envelope.event.delta === 'README summary',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.message.completed' &&
          envelope.event.text === 'README summary',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId as SessionId)
    const trace = await readSessionTrace(directory, sessionId as SessionId)
    expect(trace).toContain('tool.call')
    expect(trace).not.toContain('llm.stream')
    expect(trace).toContain('llm.response')
    expect(trace).not.toContain('secret-sentinel')
  })

  it('writes prompt build layers and prompt resources to real trace requests', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-prompt-trace-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(
      path.join(workspace, 'AGENTS.md'),
      'Trace AGENTS guidance\n',
    )
    const store = await createConfig(directory)
    const provider = new PromptAuditProvider()
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
      message: 'Audit prompt metadata',
      clientRequestId: 'request-prompt-audit',
    })

    await waitFor(
      () =>
        sent.some(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ),
      5_000,
    )
    await manager.closeSession(sessionId)

    const trace = parseTrace(
      await readSessionTrace(directory, sessionId as SessionId),
    )
    const llmRequest = trace.find((event) => event.type === 'llm.request')
    const layerKinds =
      llmRequest?.promptBuild?.layers?.map((layer) => layer.kind) ?? []
    const resources = llmRequest?.promptResources ?? []
    const resourceIds = resources.map((resource) => resource.id)
    const expectedVersionById = new Map(
      [
        ...Object.values(DEFAULT_HARNESS_PROMPT_REFS.baseInstructions),
        ...Object.values(DEFAULT_HARNESS_PROMPT_REFS.runtimeContext),
      ].map((ref) => [ref.id, ref.version]),
    )

    expect(llmRequest).toMatchObject({
      requestFields: expect.arrayContaining([
        'messages',
        'model',
        'reasoning_effort',
        'thinking',
        'tools',
      ]),
      wireParameters: {
        model: 'deepseek-v4-pro',
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      },
    })
    expect(JSON.stringify(llmRequest?.wireParameters)).not.toContain(
      'Audit prompt metadata',
    )

    expect(layerKinds).toEqual(
      expect.arrayContaining([
        'system_instruction',
        'runtime_context',
        'assistant_preferences',
        'agents_context',
      ]),
    )
    expect(resourceIds).toEqual(
      expect.arrayContaining([
        DEFAULT_HARNESS_PROMPT_REFS.baseInstructions['zh-CN'].id,
        DEFAULT_HARNESS_PROMPT_REFS.runtimeContext['zh-CN'].id,
      ]),
    )
    expect(
      resources.every(
        (resource) =>
          resource.version === expectedVersionById.get(resource.id ?? '') &&
          typeof resource.path === 'string' &&
          resource.path.length > 0 &&
          /^[a-f0-9]{64}$/u.test(resource.sha256 ?? ''),
      ),
    ).toBe(true)
    expect(String(llmRequest?.normalizedMessages?.[1]?.content ?? '')).toMatch(
      /^<environment_context/u,
    )
    expect(provider.requests[0]?.[1]?.role).toBe('user')
  })

  it('freezes a route for the full run and applies config changes to the next run', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-route-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), '# route\n')
    const store = await createConfig(directory)
    const initial = store.getPublicConfig().models.providers[0]!
    const provider = new ScriptedProvider()
    const pluginBus = new PluginEventBus()
    let updated = false
    pluginBus.on('beforeLLMCall', async () => {
      if (updated) return
      updated = true
      await store.update({
        version: 1,
        kind: 'provider',
        baseURL: initial.baseURL,
        model: 'next-run-model',
      })
    })
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      pluginBus,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    manager.startRun({
      sessionId,
      message: 'Read README',
      clientRequestId: 'route-run-one',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 1,
      5_000,
    )
    expect(
      provider.requestBodies
        .slice(0, 2)
        .map((body) =>
          body && typeof body === 'object' && !Array.isArray(body)
            ? body.model
            : undefined,
        ),
    ).toEqual([initial.model, initial.model])

    manager.startRun({
      sessionId,
      message: 'Continue',
      clientRequestId: 'route-run-two',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
      5_000,
    )
    const nextBody = provider.requestBodies.at(-1)
    expect(
      nextBody && typeof nextBody === 'object' && !Array.isArray(nextBody)
        ? nextBody.model
        : undefined,
    ).toBe('next-run-model')
    await manager.closeSession(sessionId)
  }, 15_000)

  it('keeps provider routes isolated between sessions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-routes-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'provider',
      providerId: 'generic',
      label: 'Generic',
      providerType: 'generic.chat-completions',
      baseURL: 'https://generic.invalid/v1',
      model: 'generic-model',
    })
    await store.update({
      version: 1,
      kind: 'credential',
      providerId: 'generic',
      action: 'set',
      apiKey: 'generic-secret',
    })
    const deepSeekProvider = new ForkProvider()
    const genericProvider = new ForkProvider('generic.chat-completions')
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: ({ apiKey }) =>
        apiKey === 'generic-secret' ? genericProvider : deepSeekProvider,
    })
    const deepSeekSession = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const genericSession = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'generic',
    })
    manager.startRun({
      sessionId: deepSeekSession,
      message: 'deepseek',
      clientRequestId: 'route-deepseek',
    })
    manager.startRun({
      sessionId: genericSession,
      message: 'generic',
      clientRequestId: 'route-generic',
    })
    await waitFor(
      () =>
        sent.filter(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'completed',
        ).length >= 2,
      5_000,
    )

    expect(
      [
        ...deepSeekProvider.providerRequestOverrides,
        ...genericProvider.providerRequestOverrides,
      ].map((body) =>
        body && typeof body === 'object' && !Array.isArray(body)
          ? {
              model: body.model,
              hasThinking: 'thinking' in body,
            }
          : undefined,
      ),
    ).toEqual(
      expect.arrayContaining([
        { model: 'deepseek-v4-pro', hasThinking: true },
        { model: 'generic-model', hasThinking: false },
      ]),
    )
    await Promise.all([
      manager.closeSession(deepSeekSession),
      manager.closeSession(genericSession),
    ])
  })

  it('keeps beforeLLMCall read-only and does not block on hook failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hook-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new ForkProvider()
    const diagnostics: string[] = []
    const pluginBus = new PluginEventBus({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    })
    pluginBus.on('beforeLLMCall', (context) => {
      expect(Object.isFrozen(context.request)).toBe(true)
      Reflect.set(context.request, 'model', 'forbidden')
      throw new Error('observer failed')
    })
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      pluginBus,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'hook observation',
      clientRequestId: 'hook-observation',
    })
    await waitFor(() => provider.calls === 1, 15_000)
    expect(diagnostics).toContain('observer failed')
    expect(provider.providerRequestOverride).toMatchObject({
      model: 'deepseek-v4-pro',
    })
    await manager.closeSession(sessionId)
  }, 15_000)
})
