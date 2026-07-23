import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '../../shared/json'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import type { CallId, SessionId } from '../../shared/ids'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { CompactProvider } from '../session/session-manager-compaction-fixtures'
import {
  createDurableTargetRuntime,
  type DurableTargetRuntime,
} from './create-durable-target-runtime'

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

class OrderedProvider implements LLMProvider {
  calls = 0
  readonly order: string[]
  readonly requests: ProviderChatRequest['messages'][] = []
  readonly #toolChain: boolean

  constructor(order: string[], toolChain = false) {
    this.order = order
    this.#toolChain = toolChain
  }

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.order.push('provider')
    this.requests.push(structuredClone(request.messages))
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: request.providerRequestOverride ?? {},
      requestBytes: 1,
      prefixHash: `request:${this.calls}`,
    })
    if (this.#toolChain && this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'response:tool' },
        turn: {
          role: 'assistant',
          content: null,
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

class BlockingProvider implements LLMProvider {
  readonly started: Promise<void>
  #markStarted!: () => void
  #release!: () => void
  readonly #released: Promise<void>

  constructor() {
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

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: request.providerRequestOverride ?? {},
      requestBytes: 1,
      prefixHash: 'blocking',
    })
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
  return createDurableTargetRuntime({
    configStore: input.store,
    promptDirectory: path.resolve('resources', 'prompts'),
    targetDirectory: path.join(input.root, 'target'),
    providerFactory: () => input.provider,
  })
}

describe('P4 isolated durable target runtime', () => {
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
    expect(JSON.stringify(secondProvider.requests[0])).toContain(
      'first durable question',
    )
    await secondTarget.dispose()
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
    const target = await createDurableTargetRuntime({
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

  it('commits manual compact rebuild and follow-up as one durable epoch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(root)
    const provider = new CompactProvider()
    const target = await createDurableTargetRuntime({
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
          messageChange: { mode: 'invalidate' },
        },
      },
    })
    if (compact.outcome !== 'started') throw new Error('Run did not start')
    const activeAtCommit = await target.sessions.listActiveHistory(sessionId)
    expect(activeAtCommit.at(-2)?.kind).toBe('compact_summary')
    expect(activeAtCommit.at(-1)).toMatchObject({
      kind: 'user_input',
      clientRequestId: 'request:compact-follow-up',
      parts: [{ type: 'text', text: 'focus on risks' }],
    })
    expect(JSON.stringify(activeAtCommit)).not.toContain(
      'history that must be replaced',
    )

    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      compact.runId,
    )
    const reopened = await target.sessions.listActiveHistory(sessionId)
    expect(reopened.at(-1)?.kind).toBe('assistant_turn')
    expect(
      reopened.filter((message) => message.kind === 'compact_summary'),
    ).toHaveLength(1)
    await target.dispose()
  })
})
