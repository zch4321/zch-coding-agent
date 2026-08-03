import { describe, expect, it, vi } from 'vitest'
import type { ModelPoolCapability, ModelPoolEntry } from '../../shared/config'
import { ModelPoolPlanSnapshotSchema } from '../../shared/model-pool-plan'
import { compileSchema } from '../schema-validator'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
  type AppProviderConfig,
} from '../config/schema'
import type { ConfigStore } from '../config/store'
import { ModelPoolAllocationError } from './allocator'
import { freezeModelPoolPlan } from './freezer'

const validateSafeSnapshot = compileSchema(ModelPoolPlanSnapshotSchema)

function provider(
  id: string,
  models: string[],
  overrides: Partial<AppProviderConfig> = {},
): AppProviderConfig {
  return {
    id,
    label: `Provider ${id}`,
    providerType: 'generic.chat-completions',
    revision: 1,
    baseURL: `https://${id}.example/v1`,
    model: models[0]!,
    reasoning: 'high',
    modelCatalog: [],
    modelOverrides: {},
    enabledModelIds: models,
    ...overrides,
  }
}

function entry(
  id: string,
  capability: ModelPoolCapability = 'standard',
  overrides: Partial<ModelPoolEntry> = {},
): ModelPoolEntry {
  return {
    id,
    enabled: true,
    providerId: 'provider-a',
    model: 'model-a',
    reasoning: 'high',
    capability,
    maxParallel: 4,
    ...overrides,
  }
}

function publicConfig(
  entries: ModelPoolEntry[],
  providers: AppProviderConfig[] = [provider('provider-a', ['model-a'])],
) {
  const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
  config.providers = providers
  config.activeProviderId = providers[0]!.id
  config.approval = {
    approverProviderId: providers[0]!.id,
    approverModel: providers[0]!.model,
  }
  config.modelPool = { entries }
  return toPublicConfig(config, () => ({
    credentialConfigured: true,
    credentialSource: 'safe-storage' as const,
  }))
}

function storeHarness(
  config: ReturnType<typeof publicConfig>,
  options: {
    apiKey?: (
      providerId: string,
      revision: number,
    ) => Promise<string | undefined>
    assertRevisions?: (
      revisions: readonly { providerId: string; revision: number }[],
    ) => void
  } = {},
) {
  const getPublicConfig = vi.fn(() => structuredClone(config))
  const getProviderApiKeyForRevision = vi.fn(
    options.apiKey ?? (async () => 'private-api-key'),
  )
  const assertProviderRevisions = vi.fn(options.assertRevisions ?? (() => {}))
  const store = {
    getPublicConfig,
    getProviderApiKeyForRevision,
    assertProviderRevisions,
  } as unknown as ConfigStore
  return {
    store,
    getPublicConfig,
    getProviderApiKeyForRevision,
    assertProviderRevisions,
  }
}

describe('freezeModelPoolPlan', () => {
  it('reads one snapshot and resolves one route pair per unique assigned entry', async () => {
    const harness = storeHarness(publicConfig([entry('shared-entry')]))
    const prepared = await freezeModelPoolPlan(harness.store, [
      'standard',
      'standard',
      'standard',
    ])

    expect(harness.getPublicConfig).toHaveBeenCalledOnce()
    expect(harness.getProviderApiKeyForRevision).toHaveBeenCalledOnce()
    expect(harness.assertProviderRevisions).toHaveBeenCalledWith([
      { providerId: 'provider-a', revision: 1 },
    ])
    expect(prepared.assignments).toHaveLength(3)
    expect(prepared.assignments[0]!.routes).toBe(
      prepared.assignments[1]!.routes,
    )
    expect(prepared.assignments[1]!.routes).toBe(
      prepared.assignments[2]!.routes,
    )
    expect(prepared.safeSnapshot.assignments[0]!.routes).toMatchObject({
      main: { purpose: 'main' },
      compression: { purpose: 'compression' },
    })
    expect(validateSafeSnapshot(prepared.safeSnapshot)).toBe(true)
  })

  it('produces an order-sensitive digest from all enabled entries and revisions', async () => {
    const first = entry('first', 'light')
    const second = entry('second', 'strong')
    const forward = await freezeModelPoolPlan(
      storeHarness(publicConfig([first, second])).store,
      [],
    )
    const reverse = await freezeModelPoolPlan(
      storeHarness(publicConfig([second, first])).store,
      [],
    )
    const withDisabled = await freezeModelPoolPlan(
      storeHarness(
        publicConfig([
          first,
          second,
          entry('ignored', 'standard', { enabled: false }),
        ]),
      ).store,
      [],
    )

    expect(forward.safeSnapshot.poolDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(reverse.safeSnapshot.poolDigest).not.toBe(
      forward.safeSnapshot.poolDigest,
    )
    expect(withDisabled.safeSnapshot.poolDigest).toBe(
      forward.safeSnapshot.poolDigest,
    )
  })

  it('fails capability preflight before any route or credential resolution', async () => {
    const harness = storeHarness(publicConfig([entry('light', 'light')]))

    await expect(
      freezeModelPoolPlan(harness.store, ['light', 'strong']),
    ).rejects.toBeInstanceOf(ModelPoolAllocationError)
    expect(harness.getProviderApiKeyForRevision).not.toHaveBeenCalled()
    expect(harness.assertProviderRevisions).not.toHaveBeenCalled()
  })

  it('rejects a revision change that occurs while routes are freezing', async () => {
    let currentRevision = 1
    const harness = storeHarness(publicConfig([entry('selected')]), {
      apiKey: async () => {
        currentRevision = 2
        return 'private-api-key'
      },
      assertRevisions: (revisions) => {
        if (revisions.some((item) => item.revision !== currentRevision)) {
          throw new Error(
            'Provider configuration changed while freezing route: provider-a',
          )
        }
      },
    })

    await expect(
      freezeModelPoolPlan(harness.store, ['standard']),
    ).rejects.toThrow('Provider configuration changed while freezing route')
  })

  it('checks revisions for unassigned enabled entries included in the digest', async () => {
    const providers = [
      provider('provider-a', ['model-a'], { revision: 3 }),
      provider('provider-b', ['model-b'], { revision: 7 }),
    ]
    const harness = storeHarness(
      publicConfig(
        [
          entry('selected', 'light'),
          entry('unassigned', 'strong', {
            providerId: 'provider-b',
            model: 'model-b',
          }),
        ],
        providers,
      ),
    )

    await freezeModelPoolPlan(harness.store, ['light'])

    expect(harness.assertProviderRevisions).toHaveBeenCalledWith([
      { providerId: 'provider-a', revision: 3 },
      { providerId: 'provider-b', revision: 7 },
    ])
  })

  it('does not skip or reassign when the selected entry is unavailable', async () => {
    const providers = [
      provider('provider-bad', ['model-bad']),
      provider('provider-good', ['model-good']),
    ]
    const harness = storeHarness(
      publicConfig(
        [
          entry('bad-first', 'standard', {
            providerId: 'provider-bad',
            model: 'model-bad',
          }),
          entry('good-second', 'standard', {
            providerId: 'provider-good',
            model: 'model-good',
          }),
        ],
        providers,
      ),
      {
        apiKey: async (providerId) =>
          providerId === 'provider-good' ? 'good-secret' : undefined,
      },
    )

    await expect(
      freezeModelPoolPlan(harness.store, ['standard']),
    ).rejects.toThrow('Provider provider-bad credential is not available')
    expect(harness.getProviderApiKeyForRevision).toHaveBeenCalledOnce()
    expect(harness.getProviderApiKeyForRevision).toHaveBeenCalledWith(
      'provider-bad',
      1,
    )
  })

  it('keeps frozen routes immutable relative to later hot config changes', async () => {
    const config = publicConfig([entry('selected')])
    const harness = storeHarness(config)
    const prepared = await freezeModelPoolPlan(harness.store, ['standard'])

    config.providers[0]!.baseURL = 'https://changed.example/v9'
    config.providers[0]!.revision = 99
    config.modelPool.entries[0]!.model = 'changed-model'

    expect(prepared.assignments[0]!.routes.main.snapshot).toMatchObject({
      endpoint: 'https://provider-a.example/v1/chat/completions',
      providerConfigRevision: 1,
      model: 'model-a',
    })
    expect(prepared.safeSnapshot.assignments[0]).toMatchObject({
      providerRevision: 1,
      model: 'model-a',
    })
  })

  it('keeps the safe snapshot, digest, and unavailable errors free of secrets', async () => {
    const harness = storeHarness(publicConfig([entry('selected')]), {
      apiKey: async () => 'api-key-super-secret',
    })
    const prepared = await freezeModelPoolPlan(harness.store, ['standard'])
    const serialized = JSON.stringify(prepared.safeSnapshot)

    expect(prepared.assignments[0]!.routes.main.apiKey).toBe(
      'api-key-super-secret',
    )
    expect(serialized).not.toContain('api-key-super-secret')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('apiKeyRef')
    expect(serialized).not.toContain('credentialSource')
    expect(prepared.safeSnapshot.poolDigest).not.toContain(
      'api-key-super-secret',
    )

    const missing = storeHarness(publicConfig([entry('selected')]), {
      apiKey: async () => undefined,
    })
    const error = await freezeModelPoolPlan(missing.store, ['standard']).catch(
      (caught: unknown) => caught,
    )
    expect(String(error)).not.toContain('api-key-super-secret')
    expect(String(error)).not.toContain('apiKeyRef')
  })
})
