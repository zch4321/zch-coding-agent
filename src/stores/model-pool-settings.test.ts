// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type {
  ModelPoolEntry,
  ProviderPublicConfig,
  PublicConfig,
} from '../../shared/config'
import { installApi, setupAgentTest } from './agent-test-support'
import { useModelPoolSettingsStore } from './model-pool-settings'

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
    maxParallel: 2,
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

  it('adds the first annotated model with a compatible visible reasoning effort', () => {
    const pool = useModelPoolSettingsStore()
    const providers = [
      provider('unannotated', { modelOverrides: {} }),
      provider('annotated', {
        reasoning: 'max',
        model: 'model-b',
        enabledModelIds: ['model-b'],
        modelOverrides: {
          'model-b': {
            capability: 'strong',
            reasoningEfforts: ['low', 'medium'],
          },
        },
      }),
    ]

    expect(pool.addEntry(providers)).toBe(true)
    expect(pool.entries).toEqual([
      {
        id: 'worker-1',
        enabled: false,
        providerId: 'annotated',
        model: 'model-b',
        reasoning: 'low',
        maxParallel: 1,
      },
    ])
  })

  it('persists one atomic request with unique enabled Provider revisions', async () => {
    const pool = useModelPoolSettingsStore()
    const providers = [provider('provider-a')]
    pool.entries = [
      entry(),
      entry({ id: 'worker-2', maxParallel: 4 }),
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

  it('moves and removes entries without mutating their route data', () => {
    const pool = useModelPoolSettingsStore()
    pool.entries = [entry(), entry({ id: 'worker-2', model: 'model-b' })]

    pool.moveEntry(1, -1)
    expect(pool.entries.map((item) => item.id)).toEqual([
      'worker-2',
      'worker-1',
    ])
    expect(pool.entries[0]!.model).toBe('model-b')

    pool.removeEntry(0)
    expect(pool.entries.map((item) => item.id)).toEqual(['worker-1'])
  })
})
