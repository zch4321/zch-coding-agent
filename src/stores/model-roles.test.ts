// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { PublicConfig } from '../../shared/config'
import { useModelRolesStore } from './model-roles'

function configWithRoles(roles: {
  defaultModelProvider: string
  defaultModel: string
  defaultModelReasoning: PublicConfig['models']['defaultModelReasoning']
  auxiliaryModelProvider: string
  auxiliaryModel: string
  auxiliaryModelReasoning: PublicConfig['models']['auxiliaryModelReasoning']
}): PublicConfig {
  return {
    models: {
      ...roles,
      providers: [],
      modelPool: { entries: [] },
    },
  } as unknown as PublicConfig
}

const savedRoles = {
  defaultModelProvider: 'deepseek',
  defaultModel: 'deepseek-v4-pro',
  defaultModelReasoning: 'high',
  auxiliaryModelProvider: '',
  auxiliaryModel: '',
  auxiliaryModelReasoning: 'high',
} as const

describe('model roles store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('hydrates role selections from the models config section', () => {
    const roles = useModelRolesStore()
    roles.applyConfig(
      configWithRoles({
        ...savedRoles,
        auxiliaryModelProvider: 'deepseek',
        auxiliaryModel: 'deepseek-v4-lite',
        auxiliaryModelReasoning: 'low',
      }),
    )

    expect(roles.defaultModelProvider).toBe('deepseek')
    expect(roles.defaultModel).toBe('deepseek-v4-pro')
    expect(roles.defaultModelReasoning).toBe('high')
    expect(roles.auxiliaryModel).toBe('deepseek-v4-lite')
    expect(roles.auxiliaryModelReasoning).toBe('low')
  })

  it('auto-saves the full quartet when the default model changes', async () => {
    const setConfig = vi.fn(async () => ({
      ok: true as const,
      value: { config: configWithRoles(savedRoles) },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as unknown as Partial<AgentApi>,
    })
    const roles = useModelRolesStore()
    roles.applyConfig(configWithRoles(savedRoles))

    await expect(
      roles.setDefaultModelRole('other-provider', 'other-model', 'max'),
    ).resolves.toBe(true)
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'models',
      value: {
        defaultModelProvider: 'other-provider',
        defaultModel: 'other-model',
        defaultModelReasoning: 'max',
        auxiliaryModelProvider: '',
        auxiliaryModel: '',
        auxiliaryModelReasoning: 'max',
      },
    })
  })

  it('clears the provider reference when the auxiliary model is unset', async () => {
    const setConfig = vi.fn(async () => ({
      ok: true as const,
      value: { config: configWithRoles(savedRoles) },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as unknown as Partial<AgentApi>,
    })
    const roles = useModelRolesStore()
    roles.applyConfig(
      configWithRoles({
        ...savedRoles,
        auxiliaryModelProvider: 'deepseek',
        auxiliaryModel: 'deepseek-v4-lite',
        auxiliaryModelReasoning: 'low',
      }),
    )

    await roles.setAuxiliaryModelRole('', '', 'low')
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'models',
      value: {
        defaultModelProvider: 'deepseek',
        defaultModel: 'deepseek-v4-pro',
        defaultModelReasoning: 'high',
        auxiliaryModelProvider: '',
        auxiliaryModel: '',
        auxiliaryModelReasoning: 'high',
      },
    })
  })

  it('rolls back the optimistic selection when the save fails', async () => {
    const setConfig = vi.fn(async () => ({
      ok: false as const,
      error: { message: 'write failed' },
    }))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { setConfig } as unknown as Partial<AgentApi>,
    })
    const roles = useModelRolesStore()
    roles.applyConfig(configWithRoles(savedRoles))

    await expect(
      roles.setAuxiliaryModelRole('deepseek', 'deepseek-v4-lite', 'low'),
    ).resolves.toBe(false)
    expect(roles.auxiliaryModelProvider).toBe('')
    expect(roles.auxiliaryModel).toBe('')
    expect(roles.auxiliaryModelReasoning).toBe('high')
    expect(roles.error).toBe('write failed')
  })
})
