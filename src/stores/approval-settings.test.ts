// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import { useApprovalSettingsStore } from './approval-settings'

function provider(): ProviderPublicConfig {
  return {
    id: 'provider-a',
    label: 'Provider A',
    providerType: 'generic.chat-completions',
    revision: 1,
    baseURL: 'https://provider.example/v1',
    model: 'enabled-model',
    reasoning: 'high',
    modelCatalog: [],
    modelOverrides: {},
    enabledModelIds: ['low-only-model', 'enabled-model'],
    credentialConfigured: true,
    credentialSource: 'safe-storage',
  }
}

describe('approval settings', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('selects the first enabled model without changing approval reasoning', () => {
    const approval = useApprovalSettingsStore()
    approval.approvalForm.reasoning = 'max'

    approval.selectProvider(provider())

    expect(approval.approvalForm).toEqual({
      providerId: 'provider-a',
      model: 'low-only-model',
      reasoning: 'max',
    })
  })

  it('keeps the saved approval route separate from unsaved form edits', () => {
    const approval = useApprovalSettingsStore()
    approval.applyConfig(
      {
        approval: {
          approverProviderId: 'provider-a',
          approverModel: 'saved-model',
          reasoning: 'xhigh',
        },
      } as unknown as PublicConfig,
      ['approval'],
    )

    expect(approval.approvalSavedForm).toEqual({
      providerId: 'provider-a',
      model: 'saved-model',
      reasoning: 'xhigh',
    })
    expect(approval.approvalSavedForm).not.toBe(approval.approvalForm)

    approval.approvalForm.providerId = 'provider-b'
    approval.approvalForm.model = 'draft-model'
    approval.approvalForm.reasoning = 'max'

    expect(approval.approvalSavedForm).toEqual({
      providerId: 'provider-a',
      model: 'saved-model',
      reasoning: 'xhigh',
    })
    expect(approval.approvalDirty).toBe(true)
  })

  it('persists the selected approval reasoning without transforming it', async () => {
    const approval = useApprovalSettingsStore()
    approval.approvalForm = {
      providerId: 'provider-a',
      model: 'enabled-model',
      reasoning: 'off',
    }
    const config = {
      approval: {
        approverProviderId: 'provider-a',
        approverModel: 'enabled-model',
        reasoning: 'off',
      },
    } as unknown as PublicConfig
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as Partial<AgentApi> as AgentApi,
    })

    await expect(approval.saveApproval()).resolves.toBe(true)

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'approval',
      approverProviderId: 'provider-a',
      approverModel: 'enabled-model',
      reasoning: 'off',
    })
    expect(approval.approvalSavedForm.reasoning).toBe('off')
    expect(approval.approvalDirty).toBe(false)
  })
})
