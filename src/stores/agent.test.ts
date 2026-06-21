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
import { useAgentStore } from './agent'
import { useAgentTimelineStore } from './agent-timeline'

const sessionId = 'session:test' as SessionId
const runId = 'run:test' as RunId
const callId = 'call:test' as CallId

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
    finalConfig.providers.deepseek.baseURL = 'https://example.test'
    finalConfig.providers.deepseek.model = 'new-model'
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
})
