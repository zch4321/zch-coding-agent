import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import type { CallId, SessionId } from '../../shared/ids'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import {
  AbortCompactProvider,
  CompactProvider,
} from '../session/session-manager-compaction-fixtures'
import {
  createBackendRuntime,
  type BackendRuntime,
  type CreateBackendRuntimeOptions,
} from './create-backend-runtime'

type DurableTargetRuntime = BackendRuntime

function createBackendForTest(
  options: Omit<
    CreateBackendRuntimeOptions,
    'databasePath' | 'runtimeDataDirectory'
  > & { targetDirectory: string },
) {
  const { targetDirectory, ...runtimeOptions } = options
  return createBackendRuntime({
    ...runtimeOptions,
    databasePath: path.join(targetDirectory, 'agent.db'),
    runtimeDataDirectory: targetDirectory,
  })
}

class TestSafeStorage implements SafeStorageAdapter {
  readonly platform = 'win32'

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'test'
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(value)
  }

  async decryptStringAsync(value: Buffer) {
    return { result: value.toString('utf8'), shouldReEncrypt: false }
  }
}

class OrderedProvider extends ScriptedProviderHarness {
  calls = 0
  readonly order: string[]
  readonly requests: ProviderStreamRequest['normalizedMessages'][] = []
  readonly #toolChain: boolean

  constructor(order: string[], toolChain = false) {
    super()
    this.order = order
    this.#toolChain = toolChain
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.order.push('provider')
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.#toolChain && this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'response:tool' },
        turn: {
          role: 'assistant',
          content: null,
          provider_marker: 'persisted-continuation',
          tool_calls: [
            {
              id: 'call:readme',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:readme' as CallId,
            toolId: 'read_file',
            args: { path: 'README.md' },
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
      rawResponse: { id: `response:${this.calls}` },
      turn: {
        role: 'assistant',
        content: `answer ${this.calls}`,
      },
      toolCalls: [],
      usage: { input_tokens: 10, output_tokens: 2 },
      providerState: {},
      timing: {},
    }
  }
}

class BlockingProvider extends ScriptedProviderHarness {
  readonly started: Promise<void>
  #markStarted!: () => void
  #release!: () => void
  readonly #released: Promise<void>

  constructor() {
    super()
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve
    })
    this.#released = new Promise((resolve) => {
      this.#release = resolve
    })
  }

  finish(): void {
    this.#release()
  }

  async *run(): AsyncIterable<ProviderEvent> {
    yield {
      type: 'text.delta',
      delta: 'partial durable answer',
      raw: {},
    }
    this.#markStarted()
    await this.#released
    yield {
      type: 'completed',
      rawResponse: {},
      turn: { role: 'assistant', content: 'partial durable answer complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class EmptyCompactProvider extends ScriptedProviderHarness {
  calls = 0

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (request.toolDefinitions.length === 0) {
      yield {
        type: 'completed',
        rawResponse: { id: 'empty-compact' },
        turn: { role: 'assistant', content: null },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'normal-before-compact' },
      turn: { role: 'assistant', content: 'History is durable' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

async function createConfig(root: string): Promise<ConfigStore> {
  const store = new ConfigStore(
    path.join(root, 'config.json'),
    new SecretStore(path.join(root, 'secrets.json'), new TestSafeStorage()),
    { environmentApiKey: 'test-key' },
  )
  await store.initialize()
  const provider = store.getPublicConfig().providers[0]!
  await store.update({
    version: 1,
    kind: 'provider-settings',
    providerId: provider.id,
    label: provider.label,
    providerType: provider.providerType,
    baseURL: provider.baseURL,
    model: 'deepseek-v4-pro',
    enabledModelIds: ['deepseek-v4-pro'],
    reasoning: provider.reasoning,
    limits: store.getPublicConfig().limits,
  })
  await store.update({
    version: 1,
    kind: 'privacy',
    providerNoticeAccepted: {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: new Date().toISOString(),
    },
    traceNoticeAccepted: {
      version: TRACE_NOTICE_VERSION,
      acceptedAt: new Date().toISOString(),
    },
  })
  return store
}

async function createTarget(input: {
  root: string
  store: ConfigStore
  provider: OrderedProvider
}): Promise<DurableTargetRuntime> {
  return createBackendForTest({
    configStore: input.store,
    promptDirectory: path.resolve('resources', 'prompts'),
    targetDirectory: path.join(input.root, 'target'),
    providerFactory: () => input.provider,
  })
}

describe('durable backend runtime', () => {
  it('isolates commit listeners and drains pending work before disposal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-listener-drain-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const diagnostics = vi.fn()
    const delivered = vi.fn()
    const store = await createConfig(root)
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => new OrderedProvider([]),
      onDiagnostic: diagnostics,
    })
    target.subscribe(() => {
      throw new Error('listener fixture')
    })
    target.subscribe(delivered)

    await target.projects.add({ path: workspace })
    const pending = target.coordinator.query((reader) =>
      reader.prepare('SELECT 1 AS ready').get(),
    )
    const firstDispose = target.dispose()
    const secondDispose = target.dispose()

    expect(secondDispose).toBe(firstDispose)
    await expect(pending).resolves.toMatchObject({ value: { ready: 1 } })
    await expect(firstDispose).resolves.toBeUndefined()
    expect(delivered).toHaveBeenCalledOnce()
    expect(diagnostics).toHaveBeenCalledWith(
      'Durable commit listener failed',
      expect.any(Error),
      {
        audience: 'notification',
        code: 'DURABLE_PUBLICATION_FAILURE',
        message: 'A durable state update could not be published to the UI.',
      },
    )
    await expect(
      target.coordinator.query(() => undefined),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' })
  })

  it('leaves legacy JSON state files untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-legacy-ignore-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const targetDirectory = path.join(root, 'target')
    await mkdir(targetDirectory)
    const workbenchContents = '{"legacy":"workbench sentinel"}\n'
    const changeHistoryContents = '{"legacy":"change history sentinel"}\n'
    await writeFile(
      path.join(targetDirectory, 'workbench.json'),
      workbenchContents,
      'utf8',
    )
    await writeFile(
      path.join(targetDirectory, 'change-history.json'),
      changeHistoryContents,
      'utf8',
    )
    const store = await createConfig(root)
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory,
      providerFactory: () => new OrderedProvider([]),
    })
    await target.bootstrap()
    await target.dispose()

    await expect(
      readFile(path.join(targetDirectory, 'workbench.json'), 'utf8'),
    ).resolves.toBe(workbenchContents)
    await expect(
      readFile(path.join(targetDirectory, 'change-history.json'), 'utf8'),
    ).resolves.toBe(changeHistoryContents)
  })

  it('commits first send before Provider and deduplicates after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const order: string[] = []
    await writeFile(
      path.join(workspace, 'README.md'),
      'durable tool input',
      'utf8',
    )
    const firstProvider = new OrderedProvider(order, true)
    const firstTarget = await createTarget({
      root,
      store,
      provider: firstProvider,
    })
    const projectCommit = await firstTarget.projects.add({ path: workspace })
    const project = projectCommit.commit.change.projects[0]!
    const sessionId = 'session:lazy-first' as SessionId
    const unsubscribe = firstTarget.subscribe((commit) => {
      if (commit.topic === 'session.changed') order.push('session.commit')
    })

    const payload = {
      version: 1 as const,
      kind: 'new_session' as const,
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly' as const,
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'first durable question',
      clientRequestId: 'request:lazy-first',
    }
    const started = await firstTarget.runs.start(payload)
    expect(started).toMatchObject({
      outcome: 'started',
      commit: {
        topic: 'session.changed',
        change: { session: { id: sessionId, revision: 1 } },
      },
    })
    if (started.outcome !== 'started') {
      throw new Error('Expected a started result')
    }
    expect(order[0]).toBe('session.commit')
    const sameProcessRetry = await firstTarget.runs.start(payload)
    expect(sameProcessRetry).toEqual(started)
    await firstTarget.runtime.services.sessions.waitForRunSettled(
      sessionId,
      started.runId,
    )
    expect(order.slice(0, 2)).toEqual(['session.commit', 'provider'])
    expect(firstProvider.calls).toBe(2)
    const saved = await firstTarget.sessions.get(sessionId)
    expect(saved.session.lastSeq).toBeGreaterThan(1)
    expect(
      saved.messagePage.records.some(
        (record) => record.kind === 'assistant_turn',
      ),
    ).toBe(true)
    expect(
      saved.messagePage.records.some((record) => record.kind === 'tool_result'),
    ).toBe(true)
    unsubscribe()
    await firstTarget.dispose()

    const secondProvider = new OrderedProvider([])
    const secondTarget = await createTarget({
      root,
      store,
      provider: secondProvider,
    })
    const afterRestart = await secondTarget.runs.start(payload)
    expect(afterRestart).toMatchObject({
      outcome: 'deduplicated',
      session: { id: sessionId },
      userMessage: { clientRequestId: 'request:lazy-first' },
    })
    expect(secondProvider.calls).toBe(0)
    await expect(
      secondTarget.runs.start({
        ...payload,
        message: 'same id, different body',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const continued = await secondTarget.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'second durable question',
      clientRequestId: 'request:second',
    })
    expect(continued.outcome).toBe('started')
    if (continued.outcome === 'started') {
      await secondTarget.runtime.services.sessions.waitForRunSettled(
        sessionId,
        continued.runId,
      )
    }
    expect(secondProvider.calls).toBe(1)
    expect(secondProvider.requests[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          provider_marker: 'persisted-continuation',
        }),
      ]),
    )
    const reopenedRequest = JSON.stringify(secondProvider.requests[0])
    expect(reopenedRequest).toContain('first durable question')
    expect(reopenedRequest).toContain('call:readme')
    expect(reopenedRequest).toContain('durable tool input')
    expect(reopenedRequest).toContain('answer 2')
    expect(reopenedRequest).toContain('second durable question')
    await secondTarget.dispose()
  })

  it('retries only original user messages without duplicating the user turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-retry-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new OrderedProvider([])
    const target = await createTarget({ root, store, provider })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:user-retry' as SessionId
    const first = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      title: 'Retry branch',
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      goal: {
        id: 'goal:retry',
        objective: 'Verify retry',
        status: 'paused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        continuationCount: 0,
      },
      plan: {
        id: 'plan:retry',
        objective: 'Verify retry',
        status: 'rejected',
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        continuationCount: 0,
      },
      message: 'first user turn',
      clientRequestId: 'request:first-user-turn',
    })
    if (first.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      first.runId,
    )
    const second = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'second user turn',
      clientRequestId: 'request:second-user-turn',
    })
    if (second.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      second.runId,
    )

    const before = await target.sessions.get(sessionId)
    const firstUser = before.messagePage.records.find(
      (record) =>
        record.kind === 'user_input' &&
        'clientRequestId' in record &&
        record.clientRequestId === 'request:first-user-turn',
    )
    const assistant = before.messagePage.records.find(
      (record) => record.kind === 'assistant_turn',
    )
    if (!firstUser || !assistant) throw new Error('Expected durable messages')

    await expect(
      target.runs.retry({
        version: 1,
        sessionId,
        expectedRevision: before.session.revision,
        userMessageId: assistant.id,
        clientRequestId: 'request:invalid-assistant-retry',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const staleRetryPayload = {
      version: 1,
      sessionId,
      expectedRevision: before.session.revision - 1,
      userMessageId: firstUser.id,
      clientRequestId: 'request:retry-first-user',
    } as const
    await expect(target.runs.retry(staleRetryPayload)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const retryPayload = {
      ...staleRetryPayload,
      expectedRevision: before.session.revision,
    }
    const retried = await target.runs.retry(retryPayload)
    const duplicateRetry = await target.runs.retry(retryPayload)
    expect(duplicateRetry).toEqual(retried)
    await expect(
      target.runs.retry({
        ...retryPayload,
        userMessageId: assistant.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      retried.runId,
    )
    const after = await target.sessions.get(sessionId)
    const activeUsers = after.messagePage.records.filter(
      (record) =>
        record.kind === 'user_input' &&
        record.visibility === 'visible' &&
        'clientRequestId' in record,
    )
    expect(activeUsers).toHaveLength(1)
    expect(activeUsers[0]?.id).toBe(firstUser.id)
    expect(after.session).toMatchObject({ goal: null, plan: null })
    expect(
      after.messagePage.records.filter(
        (record) =>
          record.kind === 'assistant_turn' && record.visibility === 'visible',
      ),
    ).toHaveLength(1)
    expect(provider.calls).toBe(3)
    await target.dispose()
  })

  it('leaves no empty Session when context preparation fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new OrderedProvider([])
    const target = await createTarget({ root, store, provider })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:failed-draft' as SessionId
    const modelSelection = {
      providerId: store.getPublicConfig().activeProviderId,
      model: store.getPublicConfig().providers[0]!.model,
      reasoning: store.getPublicConfig().providers[0]!.reasoning,
    }

    await expect(
      target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'readonly',
        modelSelection,
        message: '/compact',
        clientRequestId: 'request:draft-compact',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(target.sessions.getRecord(sessionId)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND',
    )

    await expect(
      target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'readonly',
        modelSelection,
        message: 'read missing attachment',
        clientRequestId: 'request:missing',
        context: {
          attachments: [{ kind: 'file', path: 'missing.txt' }],
        },
      }),
    ).rejects.toBeInstanceOf(Error)
    await expect(target.sessions.getRecord(sessionId)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND',
    )
    expect(provider.calls).toBe(0)
    expect(
      (await target.sessions.list()).records.map((record) => record.id),
    ).not.toContain(sessionId)
    await target.dispose()
  })

  it('returns a bounded runtime overlay and blocks archive while Run is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new BlockingProvider()
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => provider,
    })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:runtime-overlay' as SessionId
    const started = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'show runtime state',
      clientRequestId: 'request:runtime',
    })
    if (started.outcome !== 'started') {
      throw new Error('Expected a started result')
    }
    await provider.started
    const reloaded = await target.sessions.get(sessionId)
    expect(reloaded.runtime).toMatchObject({
      sessionId,
      runId: started.runId,
      status: 'calling_llm',
      text: 'partial durable answer',
    })
    expect(JSON.stringify(reloaded.messagePage.records)).not.toContain(
      'partial durable answer',
    )
    expect(reloaded.traceCapture).toMatchObject({
      configuredEnabled: false,
      state: 'disabled',
    })
    await expect(
      target.sessions.archive({
        sessionId,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      target.projects.remove({
        projectId: project.id,
        expectedRevision: project.revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    provider.finish()
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      started.runId,
    )
    expect((await target.sessions.get(sessionId)).runtime).toBeUndefined()
    await target.projects.remove({
      projectId: project.id,
      expectedRevision: project.revision,
    })
    await expect(target.sessions.getRecord(sessionId)).rejects.toHaveProperty(
      'code',
      'NOT_FOUND',
    )
    expect((await stat(workspace)).isDirectory()).toBe(true)
    await target.dispose()
  })

  it('journals manual compact before Provider and rebuilds a derived follow-up epoch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new CompactProvider()
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => provider,
    })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:durable-compact' as SessionId
    const first = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'history that must be replaced',
      clientRequestId: 'request:before-compact',
    })
    if (first.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      first.runId,
    )

    const compact = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: '/compact focus on risks',
      clientRequestId: 'request:compact-follow-up',
    })
    expect(compact).toMatchObject({
      outcome: 'started',
      commit: {
        change: {
          messageChange: {
            mode: 'upsert',
            records: [
              {
                kind: 'user_input',
                clientRequestId: 'request:compact-follow-up',
                inHistory: false,
                parts: [{ type: 'text', text: '/compact focus on risks' }],
                metadata: {
                  submission: {
                    type: 'control_command',
                    command: 'compact',
                  },
                },
              },
            ],
          },
        },
      },
    })
    if (compact.outcome !== 'started') throw new Error('Run did not start')
    const commandRecord =
      compact.commit.change.messageChange.mode === 'upsert'
        ? compact.commit.change.messageChange.records[0]
        : undefined
    expect(commandRecord?.kind).toBe('user_input')

    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      compact.runId,
    )
    const reopened = await target.sessions.listActiveHistory(sessionId)
    expect(reopened.at(-1)?.kind).toBe('assistant_turn')
    expect(
      reopened.filter((message) => message.kind === 'compact_summary'),
    ).toHaveLength(1)
    const derived = reopened.find(
      (message) =>
        message.kind === 'user_input' &&
        message.metadata &&
        'derivedFromMessageId' in message.metadata,
    )
    expect(derived).toMatchObject({
      kind: 'user_input',
      parts: [{ type: 'text', text: 'focus on risks' }],
      metadata: {
        derivedFromMessageId: commandRecord?.id,
        derivation: 'control_command_payload',
      },
    })
    expect(derived && 'clientRequestId' in derived).toBe(false)
    expect(JSON.stringify(reopened)).not.toContain('/compact focus on risks')
    expect(JSON.stringify(reopened)).not.toContain(
      'history that must be replaced',
    )

    const audit = await target.sessions.get(sessionId)
    expect(audit.messagePage.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: commandRecord?.id,
          inHistory: false,
          parts: [{ type: 'text', text: '/compact focus on risks' }],
        }),
      ]),
    )
    expect(
      await target.sessions.searchMessages(sessionId, {
        text: '/compact',
      }),
    ).toEqual([])
    expect(JSON.stringify(provider.requests)).not.toContain(
      '/compact focus on risks',
    )
    await target.dispose()
  })

  it('retains a failed compact command and deduplicates it after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new EmptyCompactProvider()
    const firstTarget = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => provider,
    })
    const project = (await firstTarget.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:failed-compact' as SessionId
    const first = await firstTarget.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'history survives compact failure',
      clientRequestId: 'request:failed-compact-history',
    })
    if (first.outcome !== 'started') throw new Error('Run did not start')
    await firstTarget.runtime.services.sessions.waitForRunSettled(
      sessionId,
      first.runId,
    )

    const commandPayload = {
      version: 1 as const,
      kind: 'existing_session' as const,
      sessionId,
      message: '/compact',
      clientRequestId: 'request:failed-compact',
    }
    const compact = await firstTarget.runs.start(commandPayload)
    expect(compact).toMatchObject({
      outcome: 'started',
      commit: {
        change: {
          messageChange: {
            mode: 'upsert',
            records: [
              {
                inHistory: false,
                metadata: {
                  submission: {
                    type: 'control_command',
                    command: 'compact',
                  },
                },
              },
            ],
          },
        },
      },
    })
    if (compact.outcome !== 'started') throw new Error('Run did not start')
    await firstTarget.runtime.services.sessions.waitForRunSettled(
      sessionId,
      compact.runId,
    )

    const active = await firstTarget.sessions.listActiveHistory(sessionId)
    expect(JSON.stringify(active)).toContain('history survives compact failure')
    expect(active.some((record) => record.kind === 'compact_summary')).toBe(
      false,
    )
    const audit = await firstTarget.sessions.get(sessionId)
    expect(audit.messagePage.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientRequestId: 'request:failed-compact',
          inHistory: false,
          parts: [{ type: 'text', text: '/compact' }],
        }),
      ]),
    )
    expect(await firstTarget.runs.start(commandPayload)).toEqual(compact)
    expect(provider.calls).toBe(3)
    await firstTarget.dispose()

    const afterRestartProvider = new OrderedProvider([])
    const secondTarget = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => afterRestartProvider,
    })
    expect(await secondTarget.runs.start(commandPayload)).toMatchObject({
      outcome: 'deduplicated',
      userMessage: {
        clientRequestId: 'request:failed-compact',
        inHistory: false,
      },
    })
    expect(afterRestartProvider.calls).toBe(0)
    await secondTarget.dispose()
  })

  it('returns started for a pure durable compact and ends after the summary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new CompactProvider()
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => provider,
    })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:pure-durable-compact' as SessionId
    const seed = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'history before pure compact',
      clientRequestId: 'request:pure-compact-seed',
    })
    if (seed.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      seed.runId,
    )

    const compact = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: '/compact',
      clientRequestId: 'request:pure-durable-compact',
    })
    expect(compact).toMatchObject({
      outcome: 'started',
      commit: {
        change: {
          messageChange: {
            mode: 'upsert',
            records: [
              {
                clientRequestId: 'request:pure-durable-compact',
                inHistory: false,
              },
            ],
          },
        },
      },
    })
    if (compact.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      compact.runId,
    )
    const active = await target.sessions.listActiveHistory(sessionId)
    expect(active.at(-1)?.kind).toBe('compact_summary')
    expect(
      active.some(
        (record) =>
          record.kind === 'user_input' &&
          record.metadata &&
          'derivedFromMessageId' in record.metadata,
      ),
    ).toBe(false)
    expect(provider.calls).toBe(2)
    await target.dispose()
  })

  it('keeps the durable command but rolls back an aborted compact epoch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new AbortCompactProvider()
    const target = await createBackendForTest({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(root, 'target'),
      providerFactory: () => provider,
    })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:aborted-durable-compact' as SessionId
    const seed = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'history survives durable compact abort',
      clientRequestId: 'request:abort-compact-seed',
    })
    if (seed.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      seed.runId,
    )

    const compact = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: '/compact',
      clientRequestId: 'request:aborted-durable-compact',
    })
    if (compact.outcome !== 'started') throw new Error('Run did not start')
    await provider.compactStarted.promise
    expect(
      target.runtime.services.sessions.interruptRun(sessionId, compact.runId),
    ).toBe(true)
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      compact.runId,
    )

    const active = await target.sessions.listActiveHistory(sessionId)
    expect(JSON.stringify(active)).toContain(
      'history survives durable compact abort',
    )
    expect(active.some((record) => record.kind === 'compact_summary')).toBe(
      false,
    )
    expect((await target.sessions.get(sessionId)).messagePage.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientRequestId: 'request:aborted-durable-compact',
          inHistory: false,
          parts: [{ type: 'text', text: '/compact' }],
        }),
      ]),
    )
    await target.dispose()
  })

  it('does not journal rejected slash commands and allows corrected retry ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new OrderedProvider([])
    const target = await createTarget({ root, store, provider })
    const project = (await target.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const sessionId = 'session:rejected-commands' as SessionId
    const seed = await target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: store.getPublicConfig().activeProviderId,
        model: store.getPublicConfig().providers[0]!.model,
        reasoning: store.getPublicConfig().providers[0]!.reasoning,
      },
      message: 'seed before rejected commands',
      clientRequestId: 'request:rejected-seed',
    })
    if (seed.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      seed.runId,
    )

    for (const [message, clientRequestId] of [
      ['/unknown-command', 'request:unknown-command'],
      ['/goal', 'request:missing-goal'],
      ['/plan', 'request:missing-plan'],
      ['/prompt', 'request:missing-prompt'],
      ['/skill', 'request:missing-skill'],
    ] as const) {
      await expect(
        target.runs.start({
          version: 1,
          kind: 'existing_session',
          sessionId,
          message,
          clientRequestId,
        }),
      ).rejects.toBeInstanceOf(Error)
    }

    const audit = JSON.stringify(await target.sessions.get(sessionId))
    expect(audit).not.toContain('/unknown-command')
    expect(audit).not.toContain('request:missing-goal')
    expect(audit).not.toContain('request:missing-plan')
    expect(audit).not.toContain('request:missing-prompt')
    expect(audit).not.toContain('request:missing-skill')
    expect(provider.calls).toBe(1)

    const corrected = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'corrected ordinary input',
      clientRequestId: 'request:missing-goal',
    })
    if (corrected.outcome !== 'started') {
      throw new Error('Corrected Run did not start')
    }
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      corrected.runId,
    )
    expect(JSON.stringify(await target.sessions.get(sessionId))).toContain(
      'corrected ordinary input',
    )
    expect(provider.calls).toBe(2)
    await target.dispose()
  })
})
