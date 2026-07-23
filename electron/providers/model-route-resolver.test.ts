import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import type { ConfigStore } from '../config/store'
import { resolveRunRoutes } from './model-route-resolver'

describe('resolveRunRoutes', () => {
  it('rejects an unsafe endpoint before reading credentials', async () => {
    const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
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

  it('freezes the exact endpoint and preserves approval reasoning off', async () => {
    const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
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

    expect(routes.approval.snapshot).toMatchObject({
      reasoning: 'off',
      endpoint: 'https://provider.example/v1/chat/completions',
    })
  })
})
