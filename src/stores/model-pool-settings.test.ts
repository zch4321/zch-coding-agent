// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  MAX_MODEL_POOL_ENTRIES,
  type ModelPoolEntry,
  type ProviderPublicConfig,
  type PublicConfig,
} from '../../shared/config'
import { installApi, setupAgentTest } from './agent-test-support'
import {
  modelPoolRouteKey,
  useModelPoolSettingsStore,
  type ModelPoolSelectableRoute,
} from './model-pool-settings'

setupAgentTest()

function provider(
  id: string,
  overrides: Partial<ProviderPublicConfig> = {},
): ProviderPublicConfig {
  return {
    id,
    label: `Provider ${id}`,
    providerType: 'generic.chat-completions',
    revision: 3,
    baseURL: `https://${id}.example/v1`,
    model: 'model-a',
    reasoning: 'high',
    modelCatalog: [],
    modelOverrides: {
      'model-a': { capability: 'standard' },
    },
    enabledModelIds: ['model-a'],
    credentialConfigured: true,
    credentialSource: 'safe-storage',
    ...overrides,
  }
}

function entry(overrides: Partial<ModelPoolEntry> = {}): ModelPoolEntry {
  return {
    id: 'worker-1',
    enabled: true,
    providerId: 'provider-a',
    model: 'model-a',
    reasoning: 'high',
    ...overrides,
  }
}

function config(
  entries: ModelPoolEntry[],
  providers: ProviderPublicConfig[] = [provider('provider-a')],
): PublicConfig {
  return { modelPool: { entries }, providers } as unknown as PublicConfig
}

describe('model pool settings', () => {
  it('hydrates an independent draft and tracks edits', () => {
    const pool = useModelPoolSettingsStore()
    const source = config([entry()])

    pool.applyConfig(source)
    pool.entries[0]!.id = 'edited'

    expect(source.modelPool.entries[0]!.id).toBe('worker-1')
    expect(pool.dirty).toBe(true)
  })

  it('maps distinct reasoning leaves to exact enabled routes', () => {
    const pool = useModelPoolSettingsStore()
    const routes: Array<ModelPoolSelectableRoute & { rendererLabel?: string }> =
      [
        {
          providerId: 'provider-a',
          model: 'model-a',
          reasoning: 'high',
          rendererLabel: 'Provider A / model-a / high',
        },
        { providerId: 'provider-a', model: 'model-a', reasoning: 'max' },
      ]

    pool.setSelectedRoutes(routes.map(modelPoolRouteKey), routes)

    expect(pool.entries).toEqual([
      {
        id: 'worker-1',
        enabled: true,
        providerId: 'provider-a',
        model: 'model-a',
        reasoning: 'high',
      },
      {
        id: 'worker-2',
        enabled: true,
        providerId: 'provider-a',
        model: 'model-a',
        reasoning: 'max',
      },
    ])
    expect(JSON.stringify(pool.entries)).not.toContain('rendererLabel')
  })

  it('persists one atomic request with unique enabled Provider revisions', async () => {
    const pool = useModelPoolSettingsStore()
    const providers = [provider('provider-a')]
    pool.entries = [
      entry(),
      entry({ id: 'worker-2', reasoning: 'max' }),
      entry({
        id: 'disabled-reference',
        enabled: false,
        providerId: 'missing',
        model: 'preserved-model',
      }),
    ]
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        config: config(
          pool.entries.map((poolEntry) => ({ ...poolEntry })),
          providers,
        ),
      },
    }))
    installApi({ setConfig })

    await expect(pool.save(providers)).resolves.toBe(true)

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'model-pool',
      value: { entries: pool.entries },
      expectedProviderRevisions: [{ providerId: 'provider-a', revision: 3 }],
    })
    expect(JSON.stringify(setConfig.mock.calls[0])).not.toContain('capability')
    expect(pool.dirty).toBe(false)
    expect(pool.saveStatus).toBe('saved')
  })

  it('rejects an enabled unannotated model before calling IPC', async () => {
    const pool = useModelPoolSettingsStore()
    const providers = [provider('provider-a', { modelOverrides: {} })]
    pool.entries = [entry()]
    const setConfig = vi.fn()
    installApi({ setConfig })

    await expect(pool.save(providers)).resolves.toBe(false)

    expect(pool.saveStatus).toContain('capability annotation')
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('preserves a dirty draft when Provider changes repair the saved pool', () => {
    const pool = useModelPoolSettingsStore()
    pool.applyConfig(config([entry()]))
    pool.entries[0]!.id = 'draft-name'

    pool.applyExternalConfig(config([entry({ enabled: false })]))

    expect(pool.entries[0]).toMatchObject({
      id: 'draft-name',
      enabled: true,
    })
    expect(pool.dirty).toBe(true)
    expect(pool.saveStatus).toBe('external-change')
  })

  it('preserves retained route identity while replacing membership', () => {
    const pool = useModelPoolSettingsStore()
    const high = {
      providerId: 'provider-a',
      model: 'model-a',
      reasoning: 'high',
    } as const
    const max = { ...high, reasoning: 'max' as const }
    pool.entries = [entry(), entry({ id: 'worker-2', reasoning: 'max' })]

    pool.setSelectedRoutes([modelPoolRouteKey(max)], [high, max])
    expect(pool.entries).toEqual([entry({ id: 'worker-2', reasoning: 'max' })])
  })

  it('accepts 1,000 routes and rejects an over-limit renderer selection', () => {
    const pool = useModelPoolSettingsStore()
    const routes = Array.from(
      { length: MAX_MODEL_POOL_ENTRIES + 1 },
      (_, index): ModelPoolSelectableRoute => ({
        providerId: 'provider-a',
        model: `model-${index}`,
        reasoning: 'high',
      }),
    )
    const keys = routes.map(modelPoolRouteKey)

    pool.setSelectedRoutes(keys, routes)

    expect(pool.entries).toEqual([])
    expect(pool.selectionLimitExceeded).toBe(true)

    pool.setSelectedRoutes(keys.slice(0, MAX_MODEL_POOL_ENTRIES), routes)

    expect(pool.entries).toHaveLength(MAX_MODEL_POOL_ENTRIES)
    expect(pool.entries[0]?.id).toBe('worker-1')
    expect(pool.entries[MAX_MODEL_POOL_ENTRIES - 1]?.id).toBe(
      `worker-${MAX_MODEL_POOL_ENTRIES}`,
    )
    expect(pool.selectionLimitExceeded).toBe(false)
  })
})
