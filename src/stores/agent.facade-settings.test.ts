// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import { validatePayloadLimits } from '../../electron/ipc/validators'
import { useAgentStore } from './agent'
import { useAgentTimelineStore } from './agent-timeline'
import {
  callId,
  installApi,
  multiProviderConfig,
  registerActiveSession,
  requestApproval,
  runId,
  sessionId,
  setupAgentTest,
} from './agent-test-support'

describe('agent store facade and settings', () => {
  setupAgentTest()

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

    const first = store.decideApproval({
      conversationId: store.activeConversationId!,
      decision: 'allow',
    })
    const duplicate = store.decideApproval({
      conversationId: store.activeConversationId!,
      decision: 'allow',
    })

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

  it('clears a pending approval when the matching tool completes', () => {
    installApi({})
    const store = useAgentStore()
    requestApproval(store)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'tool.completed',
      sessionId,
      runId,
      callId,
      result: {
        status: 'cancelled',
        message: 'Approval was cancelled',
      },
      approval: {
        approver: 'model',
        decision: 'dangerous',
        reason: 'Approval model timed out',
        valid: false,
        failure: 'timeout',
      },
    })

    expect(store.pendingApproval).toBeUndefined()
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
        models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
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
    expect(store.activeProviderModel).toBe('deepseek-v4-pro')
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
    registerActiveSession(store)
    store.mode = 'confirm'

    await expect(store.setMode('auto')).resolves.toBe(true)

    expect(updateSessionMode).toHaveBeenCalledWith({
      version: 1,
      sessionId,
      mode: 'auto',
    })
    expect(store.mode).toBe('auto')
  })
})
