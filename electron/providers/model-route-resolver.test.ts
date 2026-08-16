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
  config.models.providers[0]!.model = 'deepseek-v4-pro'
  config.models.providers[0]!.enabledModelIds = ['deepseek-v4-pro']
  config.models.defaultModel = 'deepseek-v4-pro'
  config.models.auxiliaryModelProvider = 'deepseek'
  config.models.auxiliaryModel = 'deepseek-v4-pro'
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

  it('rejects a reasoning effort outside the model annotation before reading credentials', async () => {
    const config = configuredAppConfig()
    config.models.providers[0]!.modelOverrides['deepseek-v4-pro'] = {
      reasoningEfforts: ['off', 'high'],
    }
    const getProviderApiKeyForRevision = vi.fn(async () => 'secret')
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision,
    } as unknown as ConfigStore

    await expect(
      resolveRunRoutes(store, {
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoning: 'max',
      }),
    ).rejects.toThrow(
      "Model deepseek-v4-pro does not support reasoning effort 'max' (supported: off, high)",
    )
    expect(getProviderApiKeyForRevision).not.toHaveBeenCalled()
  })

  it('resolves annotated models when the reasoning effort is supported', async () => {
    const config = configuredAppConfig()
    config.models.providers[0]!.modelOverrides['deepseek-v4-pro'] = {
      reasoningEfforts: ['low', 'high'],
      capability: 'strong',
    }
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision: vi.fn(async () => 'secret'),
    } as unknown as ConfigStore

    const routes = await resolveRunRoutes(store, {
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: 'low',
    })

    expect(routes.main.snapshot.reasoning).toBe('low')
    expect(routes.main.modelProfile).toMatchObject({
      id: 'deepseek-v4-pro',
      reasoningEfforts: ['low', 'high'],
      capability: 'strong',
    })
  })

  it('rejects an unsafe endpoint before reading credentials', async () => {
    const config = configuredAppConfig()
    config.models.providers[0]!.baseURL =
      'https://user:secret@provider.example/v1'
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

  it('freezes the exact endpoint and uses the provider default reasoning for approval', async () => {
    const config = configuredAppConfig()
    config.models.providers[0]!.baseURL = 'https://provider.example/v1/'
    config.models.providers[0]!.reasoning = 'high'
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

  it('resolves the approval route from the auxiliary model when configured', async () => {
    const config = configuredAppConfig()
    config.models.providers[0]!.enabledModelIds = [
      'deepseek-v4-pro',
      'aux-model',
    ]
    config.models.auxiliaryModel = 'aux-model'
    const store = {
      getPublicConfig: () => toPublicConfig(config, true),
      getProviderApiKeyForRevision: vi.fn(async () => 'secret'),
    } as unknown as ConfigStore

    const routes = await resolveRunRoutes(store, {
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: 'off',
    })

    expect(routes.main.snapshot.model).toBe('deepseek-v4-pro')
    expect(routes.approval?.snapshot).toMatchObject({
      purpose: 'approval',
      model: 'aux-model',
    })
  })

  it('falls back to the main model for approval when auxiliary credentials are absent', async () => {
    const config = configuredAppConfig()
    config.models.providers.push({
      ...structuredClone(config.models.providers[0]!),
      id: 'approval-only',
      label: 'Approval only',
    })
    config.models.auxiliaryModelProvider = 'approval-only'
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
    expect(routes.approval?.snapshot).toMatchObject({
      purpose: 'approval',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(onDiagnostic).toHaveBeenCalledOnce()
  })

  it('uses the main model for approval when the auxiliary provider is missing', async () => {
    const config = configuredAppConfig()
    config.models.auxiliaryModelProvider = 'missing-provider'
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

    expect(routes.approval?.snapshot).toMatchObject({
      purpose: 'approval',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(onDiagnostic).not.toHaveBeenCalled()
  })
})
