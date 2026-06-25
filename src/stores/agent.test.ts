// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import { validatePayloadLimits } from '../../electron/ipc/validators'
import { conversationToMarkdown } from '../../shared/conversation-markdown'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import type { ConversationRecord as SharedConversationRecord } from '../../shared/workbench'
import { useAgentStore } from './agent'
import { useAgentTimelineStore } from './agent-timeline'

const sessionId = 'session:test' as SessionId
const runId = 'run:test' as RunId
const callId = 'call:test' as CallId
const stamp = '2026-06-20T00:00:00.000Z'

function installApi(api: Partial<AgentApi>) {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
}

function requestApproval(store: ReturnType<typeof useAgentStore>) {
  store.sessionId = sessionId
  store.handleAgentEvent({
    schemaVersion: 1,
    seq: 1,
    ts: '2026-06-20T00:00:00.000Z',
    type: 'approval.requested',
    sessionId,
    runId,
    callId,
    kind: 'tool',
    tool: 'write_file',
    args: { path: 'note.txt', content: 'updated' },
    reason: 'Write the requested file',
    policySignals: [],
    diff: '--- a/note.txt\n+++ b/note.txt',
    diffHash: 'diff-hash',
    rememberable: true,
    expiresAt: '2026-06-20T01:00:00.000Z',
  })
}

function markdownConversation(
  overrides: Partial<SharedConversationRecord> = {},
): SharedConversationRecord {
  return {
    id: 'conversation:imported-source',
    projectPath: 'F:/untrusted/source',
    title: 'Imported source',
    model: 'deepseek-chat',
    mode: 'auto',
    messages: [
      {
        id: 'message:source',
        role: 'user',
        text: 'imported body',
        reasoning: '',
        order: 0,
      },
    ],
    tools: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

function multiProviderConfig() {
  const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
  config.providers[0].modelCatalog = [
    { id: 'deepseek-chat' },
    { id: 'deepseek-reasoner' },
  ]
  config.providers.push({
    ...structuredClone(config.providers[0]),
    id: 'generic',
    label: 'Generic Provider',
    profile: 'generic',
    baseURL: 'https://generic.example/v1',
    model: 'generic-chat',
    reasoning: 'off',
    modelCatalog: [{ id: 'generic-chat' }, { id: 'generic-coder' }],
    modelOverrides: {
      'generic-large': { contextWindowTokens: 128_000 },
    },
    credentialConfigured: false,
    credentialSource: 'none',
  })
  config.approval.approverProviderId = 'deepseek'
  return config
}

describe('agent store regressions', () => {
  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('forwards facade state to the focused domain stores', () => {
    const store = useAgentStore()
    const timeline = useAgentTimelineStore()

    store.input = 'facade draft'
    expect(timeline.input).toBe('facade draft')

    timeline.input = 'domain draft'
    expect(store.input).toBe('domain draft')
  })

  it('persists cloneable workbench snapshots through the Electron bridge', () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => {
        expect(() => structuredClone(payload.workbench)).not.toThrow()
        return {
          version: 1 as const,
          ok: true as const,
          value: payload.workbench,
        }
      },
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'

    store.createConversation()

    expect(saveWorkbench).toHaveBeenCalled()
  })

  it('submits an approval once and retains the reviewed diff', async () => {
    let resolveDecision:
      | ((value: {
          version: 1
          ok: true
          value: { accepted: boolean }
        }) => void)
      | undefined
    const decideApproval = vi.fn(
      (payload: Parameters<AgentApi['decideApproval']>[0]) => {
        void payload
        return new Promise<{
          version: 1
          ok: true
          value: { accepted: boolean }
        }>((resolve) => {
          resolveDecision = resolve
        })
      },
    )
    installApi({ decideApproval })
    const store = useAgentStore()
    requestApproval(store)

    const first = store.decideApproval('allow')
    const duplicate = store.decideApproval('allow')

    expect(store.approvalSubmitting).toBe(true)
    expect(decideApproval).toHaveBeenCalledTimes(1)
    expect(
      Object.hasOwn(decideApproval.mock.calls[0]?.[0] ?? {}, 'remember'),
    ).toBe(false)
    expect(validatePayloadLimits(decideApproval.mock.calls[0]?.[0])).toEqual({
      valid: true,
    })
    resolveDecision?.({
      version: 1,
      ok: true,
      value: { accepted: true },
    })
    await Promise.all([first, duplicate])

    expect(store.pendingApproval).toBeUndefined()
    expect(store.latestReviewedApproval).toMatchObject({
      callId,
      diffHash: 'diff-hash',
      decision: 'allowed',
    })
  })

  it('saves one immutable provider draft in a single atomic request', async () => {
    const oldConfig = toPublicConfig(DEFAULT_APP_CONFIG, true)
    const finalConfig = structuredClone(oldConfig)
    finalConfig.providers[0].baseURL = 'https://example.test'
    finalConfig.providers[0].model = 'new-model'
    finalConfig.approval.approverModel = 'new-approver'
    finalConfig.limits.tokenEstimation = {
      mode: 'custom-bytes',
      bytesPerToken: 2.5,
    }
    const setConfig = vi.fn(
      async (payload: Parameters<AgentApi['setConfig']>[0]) => {
        void payload
        return {
          version: 1 as const,
          ok: true as const,
          value: { config: finalConfig },
        }
      },
    )
    installApi({ setConfig })
    const store = useAgentStore()
    store.applyConfig(oldConfig)
    store.providerForm.baseURL = 'https://example.test'
    store.providerForm.model = 'new-model'
    store.providerForm.approverModel = 'new-approver'
    store.providerForm.tokenEstimationMode = 'custom-bytes'
    store.providerForm.bytesPerToken = 2.5

    await store.saveProvider()

    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider-settings',
        baseURL: 'https://example.test',
        model: 'new-model',
        approverModel: 'new-approver',
        limits: expect.objectContaining({
          tokenEstimation: {
            mode: 'custom-bytes',
            bytesPerToken: 2.5,
          },
        }),
      }),
    )
    expect(Object.hasOwn(setConfig.mock.calls[0]?.[0] ?? {}, 'apiKey')).toBe(
      false,
    )
    expect(store.providerForm).toMatchObject({
      baseURL: 'https://example.test',
      model: 'new-model',
      approverModel: 'new-approver',
      tokenEstimationMode: 'custom-bytes',
      bytesPerToken: 2.5,
    })
    expect(store.providerDirty).toBe(false)
    expect(store.providerSaveStatus).toBe('Saved')
  })

  it('does not overwrite an unsaved provider draft with another section', () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    const store = useAgentStore()
    store.applyConfig(config)
    store.providerForm.model = 'draft-model'

    const loggingResponse = structuredClone(config)
    loggingResponse.logging.retentionDays = 30
    store.applyConfig(loggingResponse, ['logging'])

    expect(store.providerForm.model).toBe('draft-model')
    expect(store.providerDirty).toBe(true)
    expect(store.loggingForm.retentionDays).toBe(30)
  })

  it('keeps provider editing selection separate from the active provider', async () => {
    installApi({
      listProviderModels: vi.fn(async () => ({
        version: 1 as const,
        ok: true as const,
        value: {
          models: [
            {
              id: 'generic-chat',
              availability: 'provider' as const,
              capabilitySource: 'default' as const,
              contextWindowTokens: 64_000,
            },
          ],
          stale: false,
        },
      })),
    })
    const store = useAgentStore()
    store.applyConfig(multiProviderConfig())

    expect(store.providerCardSummaries).toMatchObject([
      {
        id: 'deepseek',
        isActive: true,
        isSelected: true,
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        id: 'generic',
        isActive: false,
        isSelected: false,
        models: ['generic-chat', 'generic-coder', 'generic-large'],
      },
    ])

    await store.selectProviderForEditing('generic')

    expect(store.activeProviderId).toBe('deepseek')
    expect(store.activeProviderModel).toBe('deepseek-chat')
    expect(store.credentialConfigured).toBe(true)
    expect(store.selectedCredentialConfigured).toBe(false)
    expect(store.providerForm).toMatchObject({
      providerId: 'generic',
      label: 'Generic Provider',
      model: 'generic-chat',
      profile: 'generic',
    })
  })

  it('sends provider CRUD configuration requests through IPC', async () => {
    const config = multiProviderConfig()
    const setConfig = vi.fn(
      async (payload: Parameters<AgentApi['setConfig']>[0]) => {
        const next = structuredClone(config)
        if (payload.kind === 'provider-select') {
          next.activeProviderId = payload.providerId
        } else if (payload.kind === 'provider-copy') {
          const source = next.providers.find(
            (provider) => provider.id === payload.sourceProviderId,
          )
          if (source) {
            next.providers.push({
              ...structuredClone(source),
              id: payload.providerId,
              label: payload.label,
              credentialConfigured: false,
              credentialSource: 'none',
            })
          }
        } else if (payload.kind === 'provider-delete') {
          next.providers = next.providers.filter(
            (provider) => provider.id !== payload.providerId,
          )
          next.activeProviderId =
            payload.fallbackProviderId ?? next.providers[0].id
        }
        return {
          version: 1 as const,
          ok: true as const,
          value: { config: next },
        }
      },
    )
    installApi({ setConfig })
    const store = useAgentStore()
    store.applyConfig(config)

    await store.setActiveProvider('generic')
    await store.copyProvider('generic')
    await store.deleteProvider('generic')

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      version: 1,
      kind: 'provider-select',
      providerId: 'generic',
    })
    expect(setConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        version: 1,
        kind: 'provider-copy',
        sourceProviderId: 'generic',
        providerId: 'generic-provider-copy',
        label: 'Generic Provider Copy',
      }),
    )
    expect(setConfig).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        version: 1,
        kind: 'provider-delete',
        providerId: 'generic',
      }),
    )
  })

  it('updates the active runtime session when permission mode changes', async () => {
    const updateSessionMode = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true },
    }))
    installApi({ updateSessionMode })
    const store = useAgentStore()
    store.sessionId = sessionId
    store.mode = 'confirm'

    await expect(store.setMode('auto')).resolves.toBe(true)

    expect(updateSessionMode).toHaveBeenCalledWith({
      version: 1,
      sessionId,
      mode: 'auto',
    })
    expect(store.mode).toBe('auto')
  })

  it('sends typed @path and selected chips as structured context attachments', async () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.privacy.providerNoticeAccepted = {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-22T00:00:00.000Z',
    }
    const createSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { sessionId },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    installApi({ createSession, startRun })
    const store = useAgentStore()
    store.bridgeAvailable = true
    store.applyConfig(config)
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    store.input = 'Review @README.md and @src/'
    store.contextAttachments = [
      { kind: 'directory', path: 'docs', source: 'picker' },
    ]

    await store.sendMessage()

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          attachments: [
            { kind: 'directory', path: 'docs', source: 'picker' },
            { kind: 'file', path: 'README.md', source: 'mention' },
            { kind: 'directory', path: 'src', source: 'mention' },
          ],
        },
      }),
    )
    expect(store.contextAttachments).toEqual([])
    expect(store.messages[0]?.attachments).toMatchObject([
      { kind: 'directory', path: 'docs' },
      { kind: 'file', path: 'README.md' },
      { kind: 'directory', path: 'src' },
    ])
  })

  it('does not change conversation recency when merely switching', async () => {
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const first = store.createConversation()
    const second = store.createConversation()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (!first || !second) return

    first.updatedAt = '2026-06-20T00:00:00.000Z'
    second.updatedAt = '2026-06-20T00:01:00.000Z'

    await store.selectConversation(first.id)

    expect(second.updatedAt).toBe('2026-06-20T00:01:00.000Z')
    expect(store.activeConversationId).toBe(first.id)
  })

  it('publishes a new renderer workspace only after main-process config switches', async () => {
    const firstWorkspace = 'F:/workspace/first'
    const secondWorkspace = 'F:/workspace/second'
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    config.workspace.lastOpened = secondWorkspace
    let resolveSetConfig!: (
      value: Awaited<ReturnType<AgentApi['setConfig']>>,
    ) => void
    const setConfig = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<AgentApi['setConfig']>>>((resolve) => {
          resolveSetConfig = resolve
        }),
    )
    installApi({ setConfig })
    const store = useAgentStore()
    store.workspacePath = firstWorkspace
    const first = store.createConversation(firstWorkspace)
    const second = store.createConversation(secondWorkspace)
    if (!first || !second) throw new Error('Expected conversations')
    store.activeConversationId = first.id
    store.restoreActiveConversation()

    const switching = store.selectConversation(second.id)
    await Promise.resolve()

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'workspace',
      lastOpened: secondWorkspace,
    })
    expect(store.workspacePath).toBe(firstWorkspace)

    resolveSetConfig({
      version: 1,
      ok: true,
      value: { config },
    })
    await expect(switching).resolves.toBe(true)
    expect(store.workspacePath).toBe(secondWorkspace)
    expect(store.activeConversationId).toBe(second.id)
  })

  it('creates a new conversation for a specific project workspace', async () => {
    const firstWorkspace = 'F:/workspace/first'
    const secondWorkspace = 'F:/workspace/second'
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    config.workspace.lastOpened = secondWorkspace
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config },
    }))
    installApi({ setConfig })
    const store = useAgentStore()
    store.workspacePath = firstWorkspace
    store.registerProject(firstWorkspace)
    store.registerProject(secondWorkspace)

    await expect(store.newConversation(secondWorkspace)).resolves.toBe(true)

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'workspace',
      lastOpened: secondWorkspace,
    })
    expect(store.workspacePath).toBe(secondWorkspace)
    expect(store.activeConversation?.projectPath).toBe(secondWorkspace)
  })

  it('ignores duplicate Agent events and reports sequence gaps', () => {
    const store = useAgentStore()
    store.sessionId = sessionId
    const first = {
      schemaVersion: 1 as const,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta' as const,
      sessionId,
      runId,
      delta: 'one',
    }

    store.handleAgentEvent(first)
    store.handleAgentEvent(first)
    store.handleAgentEvent({ ...first, seq: 3, delta: 'three' })

    expect(store.messages[0]?.text).toBe('onethree')
    expect(store.agentEventGap).toContain('expected 2, received 3')
  })

  it('starts a new assistant segment after a tool call', () => {
    const store = useAgentStore()
    store.sessionId = sessionId
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'First response',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'tool.proposed',
      sessionId,
      runId,
      callId,
      tool: 'run_command',
      args: { mode: 'shell', command: 'npm --version' },
      reason: 'Check npm version',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 3,
      ts: '2026-06-20T00:00:02.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'Second response',
    })

    expect(store.messages.map((message) => message.text)).toEqual([
      'First response',
      'Second response',
    ])
    expect([
      store.messages[0]?.order,
      store.tools[0]?.order,
      store.messages[1]?.order,
    ]).toEqual([1, 2, 3])
  })

  it('attaches auto approval summaries to completed tools', () => {
    const store = useAgentStore()
    store.sessionId = sessionId
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'tool.proposed',
      sessionId,
      runId,
      callId,
      tool: 'write_file',
      args: { path: 'note.txt', content: 'updated' },
      reason: 'Write the requested file',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'tool.completed',
      sessionId,
      runId,
      callId,
      result: { status: 'ok', content: { path: 'note.txt' } },
      approval: {
        approver: 'model',
        decision: 'safe',
        reason: 'Single bounded workspace edit',
        valid: true,
      },
    })

    expect(store.tools[0]).toMatchObject({
      status: 'completed',
      approval: {
        approver: 'model',
        decision: 'safe',
        reason: 'Single bounded workspace edit',
      },
    })
  })

  it('renders completed assistant messages even if stream deltas were missed', () => {
    const store = useAgentStore()
    store.sessionId = sessionId

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.message.completed',
      sessionId,
      runId,
      text: 'Final answer',
      reasoning: 'Final reasoning',
    })

    expect(store.messages[0]).toMatchObject({
      role: 'assistant',
      runId,
      text: 'Final answer',
      reasoning: 'Final reasoning',
    })
  })

  it('uses completed assistant messages as an idempotent final snapshot', () => {
    const store = useAgentStore()
    store.sessionId = sessionId

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'Part',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'assistant.message.completed',
      sessionId,
      runId,
      text: 'Part plus final text',
    })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]?.text).toBe('Part plus final text')
  })

  it('auto-titles the conversation from the first user message', async () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.privacy.providerNoticeAccepted = {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-22T00:00:00.000Z',
    }
    const createSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { sessionId },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    installApi({ createSession, startRun })
    const store = useAgentStore()
    store.bridgeAvailable = true
    store.applyConfig(config)
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    store.input = 'Fix the flaky terminal test'

    await store.sendMessage()

    expect(store.activeConversation?.title).toBe('Fix the flaky terminal test')
  })

  it('approves an awaiting plan and starts a run', async () => {
    const plan = {
      id: 'plan:test',
      objective: 'Review this plan',
      status: 'awaiting_review' as const,
      items: [
        {
          id: 'item:1',
          title: 'Inspect state',
          status: 'pending' as const,
          updatedAt: stamp,
        },
      ],
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    const updatePlanStatus = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true, plan: { ...plan, status: 'active' as const } },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    installApi({ updatePlanStatus, startRun })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    store.sessionId = sessionId
    store.plan = plan

    await store.approvePlan()

    expect(updatePlanStatus).toHaveBeenCalledWith({
      version: 1,
      sessionId,
      status: 'active',
    })
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        sessionId,
        message: '用户已批准当前计划。继续执行已激活的计划。',
      }),
    )
    expect(store.plan?.status).toBe('active')
    expect(store.activeRunId).toBe(runId)
    expect(store.messages.at(-1)?.text).toContain('用户已批准当前计划')
  })

  it('forks a conversation into a new branch, truncating tools after the fork point', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.title = 'Original conversation'
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
      { id: 'm3', role: 'user', text: 'three', reasoning: '', order: 4 },
      { id: 'm4', role: 'assistant', text: 'four', reasoning: '', order: 5 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
      {
        callId: 'call-after' as CallId,
        runId,
        tool: 'write_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 6,
      },
    ]

    const result = await store.forkConversation(original.id, 'm2')

    expect(result).toBe(true)
    const forked = store.activeConversation
    expect(forked).toBeDefined()
    expect(forked?.id).not.toBe(original.id)
    expect(forked?.parentId).toBe(original.id)
    expect(forked?.parentTitle).toBe('Original conversation')
    expect(forked?.forkedAt).toBeDefined()
    // The fork keeps messages up to and including the fork point.
    expect(forked?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Tools recorded after the fork point are dropped; only the earlier one is kept.
    expect(forked?.tools?.map((tool) => tool.callId)).toEqual([callId])
    // The original conversation is untouched.
    expect(
      store.conversations.find((c) => c.id === original.id)?.messages,
    ).toHaveLength(4)
  })

  it('forks at the latest message without dropping timeline state', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
    ]
    original.usage = [
      {
        runId,
        callId,
        order: 3,
        usage: {
          scope: 'main',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'deepseek-chat',
          contextWindowTokens: 64_000,
          contextWindowSource: 'default',
          raw: null,
        },
      },
    ]
    original.goal = {
      id: 'goal:one',
      objective: 'Finish the review',
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    original.plan = {
      id: 'plan:one',
      objective: 'Finish the review',
      items: [
        {
          id: 'item:one',
          title: 'Run checks',
          status: 'completed',
          updatedAt: stamp,
          result: 'done',
          evidence: 'unit test',
        },
      ],
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    original.orchestratorEntries = [
      {
        id: 'orchestrator:one',
        kind: 'goal-continuation',
        text: 'continue',
        createdAt: stamp,
        order: 4,
      },
    ]
    original.latestReviewedApproval = {
      runId,
      callId,
      tool: 'write_file',
      reason: 'Review diff',
      diff: '--- a/file\n+++ b/file',
      decision: 'allowed',
    }

    const result = await store.forkConversation(original.id, 'm2')

    expect(result).toBe(true)
    const forked = store.activeConversation
    expect(forked?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(forked?.tools).toHaveLength(1)
    expect(forked?.usage).toHaveLength(1)
    expect(forked?.orchestratorEntries).toHaveLength(1)
    expect(forked?.goal).toEqual(original.goal)
    expect(forked?.plan).toEqual(original.plan)
    expect(forked?.latestReviewedApproval).toEqual(
      original.latestReviewedApproval,
    )
  })

  it('reverts in place by discarding messages after the kept reply', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
      { id: 'm3', role: 'user', text: 'three', reasoning: '', order: 4 },
      { id: 'm4', role: 'assistant', text: 'four', reasoning: '', order: 5 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
      {
        callId: 'call-after' as CallId,
        runId,
        tool: 'write_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 6,
      },
    ]

    const result = await store.revertConversationAfterMessage('m2')

    expect(result).toBe(true)
    // No new conversation is created; the same conversation is mutated in place.
    expect(store.conversations).toHaveLength(1)
    const reverted = store.activeConversation
    expect(reverted?.id).toBe(original.id)
    // The kept reply (m2) and everything before it remain; m3/m4 are gone.
    expect(reverted?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Tools recorded after the kept reply are also removed.
    expect(reverted?.tools?.map((tool) => tool.callId)).toEqual([callId])
  })

  it('imports markdown into the current workspace instead of trusting projectPath', async () => {
    const trustedWorkspace = 'F:/workspace/trusted'
    const markdown = conversationToMarkdown(
      markdownConversation({
        projectPath: 'C:/Users/alice/sensitive',
        title: 'External path import',
      }),
    )
    const importConversationMarkdown = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { canceled: false, markdown },
    }))
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ importConversationMarkdown, saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = trustedWorkspace

    const result = await store.importConversationViaDialog()

    expect(result).toMatchObject({ canceled: false })
    expect(store.activeConversation?.projectPath).toBe(trustedWorkspace)
    expect(store.projects.map((project) => project.path)).toEqual([
      trustedWorkspace,
    ])
    expect(
      store.projects.some(
        (project) => project.path === 'C:/Users/alice/sensitive',
      ),
    ).toBe(false)
    expect(saveWorkbench).toHaveBeenCalledTimes(1)
    expect(
      saveWorkbench.mock.calls[0]?.[0].workbench.conversations[0]?.projectPath,
    ).toBe(trustedWorkspace)
  })

  it('rejects schema-invalid imported markdown before mutating state', async () => {
    const markdown = conversationToMarkdown(
      markdownConversation({
        messages: [
          {
            id: 'message:too-large',
            role: 'user',
            text: 'x'.repeat(1_000_001),
            reasoning: '',
            order: 0,
          },
        ],
      }),
    )
    const importConversationMarkdown = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { canceled: false, markdown },
    }))
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ importConversationMarkdown, saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/trusted'

    const result = await store.importConversationViaDialog()

    expect(result.canceled).toBe(false)
    expect(result.error).toContain('/messages/0/text')
    expect(store.conversations).toHaveLength(0)
    expect(store.projects).toHaveLength(0)
    expect(saveWorkbench).not.toHaveBeenCalled()
  })
})
