import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import type { ConfigStore } from '../config/store'
import {
  resolveModelRoutePairFromConfig,
  resolveRunRoutes,
} from './model-route-resolver'

function configuredAppConfig(): AppConfig {
  const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
  config.providers[0]!.model = 'deepseek-v4-pro'
  config.providers[0]!.enabledModelIds = ['deepseek-v4-pro']
  config.approval.approverModel = 'deepseek-v4-pro'
  return config
}

describe('resolveRunRoutes', () => {
  it('resolves a main/compression pair from one supplied snapshot and credential read', async () => {
    const config = configuredAppConfig()
    const snapshot = toPublicConfig(config, true)
    const getProviderApiKeyForRevision = vi.fn(async () => 'secret')
    const store = {
      getPublicConfig: vi.fn(() => {
        throw new Error('explicit pair resolver must not reread config')
      }),
      getProviderApiKeyForRevision,
    } as unknown as ConfigStore

    const pair = await resolveModelRoutePairFromConfig(store, snapshot, {
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: 'max',
    })

    expect(getProviderApiKeyForRevision).toHaveBeenCalledOnce()
    expect(pair.main.snapshot).toMatchObject({
      purpose: 'main',
      reasoning: 'max',
    })
    expect(pair.compression.snapshot).toMatchObject({
      purpose: 'compression',
      reasoning: 'max',
    })
  })

  it('rejects models outside the enabled Provider pool', async () => {
    const config = configuredAppConfig()
    const getProviderApiKeyForRevision = vi.fn(async () => 'secret')
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision,
    } as unknown as ConfigStore

    await expect(
      resolveRunRoutes(store, {
        providerId: 'deepseek',
        model: 'disabled-model',
        reasoning: 'high',
      }),
    ).rejects.toThrow(/not enabled/u)
    expect(getProviderApiKeyForRevision).not.toHaveBeenCalled()
  })

  it('rejects an unsafe endpoint before reading credentials', async () => {
    const config = configuredAppConfig()
    config.providers[0]!.baseURL = 'https://user:secret@provider.example/v1'
    const getProviderApiKeyForRevision = vi.fn(async () => 'secret')
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision,
    } as unknown as ConfigStore

    await expect(
      resolveRunRoutes(store, {
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoning: 'high',
      }),
    ).rejects.toThrow(/credentials/u)
    expect(getProviderApiKeyForRevision).not.toHaveBeenCalled()
  })

  it('freezes the exact endpoint and raises approval reasoning off to high', async () => {
    const config = configuredAppConfig()
    config.providers[0]!.baseURL = 'https://provider.example/v1/'
    config.providers[0]!.reasoning = 'off'
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision: vi.fn(async () => 'secret'),
    } as unknown as ConfigStore

    const routes = await resolveRunRoutes(store, {
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: 'off',
    })

    expect(routes.approval?.snapshot).toMatchObject({
      reasoning: 'high',
      endpoint: 'https://provider.example/v1/chat/completions',
    })
  })

  it('keeps main and compression routes when approval credentials are absent', async () => {
    const config = configuredAppConfig()
    config.providers.push({
      ...structuredClone(config.providers[0]!),
      id: 'approval-only',
      label: 'Approval only',
    })
    config.approval.approverProviderId = 'approval-only'
    const onDiagnostic = vi.fn()
    const store = {
      getPublicConfig: () =>
        toPublicConfig(config, (provider) => ({
          credentialConfigured: provider.id === 'deepseek',
          credentialSource:
            provider.id === 'deepseek' ? 'safe-storage' : 'none',
        })),
      getProviderApiKeyForRevision: vi.fn(async (providerId: string) =>
        providerId === 'deepseek' ? 'secret' : undefined,
      ),
    } as unknown as ConfigStore

    const routes = await resolveRunRoutes(
      store,
      {
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoning: 'high',
      },
      { onDiagnostic },
    )

    expect(routes.main.snapshot.purpose).toBe('main')
    expect(routes.compression.snapshot.purpose).toBe('compression')
    expect(routes.approval).toBeUndefined()
    expect(onDiagnostic).toHaveBeenCalledOnce()
  })

  it('keeps main and compression routes when approval provider is missing', async () => {
    const config = configuredAppConfig()
    config.approval.approverProviderId = 'missing-provider'
    const onDiagnostic = vi.fn()
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision: vi.fn(async () => 'secret'),
    } as unknown as ConfigStore

    const routes = await resolveRunRoutes(
      store,
      {
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoning: 'high',
      },
      { onDiagnostic },
    )

    expect(routes.approval).toBeUndefined()
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining('missing-provider'),
    )
  })
})
