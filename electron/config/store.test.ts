import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigSetRequestSchema,
  type ConfigSetRequest,
  type ModelPoolEntry,
  type ProviderPublicConfig,
} from '../../shared/config'
import { compileSchema } from '../schema-validator'
import legacyAppConfigV9 from './fixtures/app-config-v9.json'
import { DEFAULT_APP_CONFIG, type AppConfig } from './schema'
import type { SafeStorageAdapter } from './secret-store'
import { SecretStorageUnavailableError, SecretStore } from './secret-store'
import { ConfigStore } from './store'

class FakeSafeStorage implements SafeStorageAdapter {
  readonly platform: NodeJS.Platform
  available = true
  backend = 'system'
  failAvailability = false
  failEncryption = false
  shouldReEncrypt = false
  encryptions = 0

  constructor(platform: NodeJS.Platform = 'win32') {
    this.platform = platform
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    if (this.failAvailability) {
      throw new Error('temporarily unavailable')
    }
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    if (this.failEncryption) {
      throw new Error('locked')
    }
    this.encryptions += 1
    return Buffer.from(`encrypted:${value}`)
  }

  async decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return {
      result: value.toString().replace(/^encrypted:/, ''),
      shouldReEncrypt: this.shouldReEncrypt,
    }
  }
}

async function createStores(adapter = new FakeSafeStorage()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
  const secretStore = new SecretStore(
    path.join(directory, 'secrets.json'),
    adapter,
  )
  const configStore = new ConfigStore(
    path.join(directory, 'config.json'),
    secretStore,
  )
  await configStore.initialize()
  return { directory, adapter, secretStore, configStore }
}

function modelPoolEntry(
  overrides: Partial<ModelPoolEntry> = {},
): ModelPoolEntry {
  return {
    id: 'worker-entry',
    enabled: true,
    providerId: 'deepseek',
    model: 'worker-model',
    reasoning: 'high',
    maxParallel: 3,
    ...overrides,
  }
}

async function configurePoolProvider(
  configStore: ConfigStore,
  options: { credential?: boolean } = { credential: true },
): Promise<ProviderPublicConfig> {
  const initial = configStore.getPublicConfig().providers[0]!
  await configStore.update({
    version: 1,
    kind: 'provider',
    providerId: initial.id,
    label: initial.label,
    providerType: initial.providerType,
    baseURL: 'https://provider.example/v1',
    model: 'main-model',
    enabledModelIds: ['main-model', 'worker-model'],
    modelOverrides: {
      'worker-model': { capability: 'standard' },
    },
    reasoning: 'high',
  })
  if (options.credential !== false) {
    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: initial.id,
      action: 'set',
      apiKey: 'model-pool-secret',
    })
  }
  return configStore.getPublicConfig().providers[0]!
}

function modelPoolUpdate(
  provider: ProviderPublicConfig,
  entries: ModelPoolEntry[],
): Extract<ConfigSetRequest, { kind: 'model-pool' }> {
  return {
    version: 1,
    kind: 'model-pool',
    value: { entries },
    expectedProviderRevisions: entries.some(
      (entry) => entry.enabled && entry.providerId === provider.id,
    )
      ? [{ providerId: provider.id, revision: provider.revision }]
      : [],
  }
}

describe('ConfigStore', () => {
  it('deletes a legacy config and rebuilds clean v18 defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const configPath = path.join(directory, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 8, legacy: true }),
      'utf8',
    )
    const secretStore = new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    )
    const store = new ConfigStore(configPath, secretStore)

    await expect(store.initialize()).resolves.toMatchObject({
      config: { schemaVersion: 18 },
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 18,
      limits: { maxStepsPerRun: 0 },
    })
  })

  it('backs up an unreadable config before resetting it to defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const configPath = path.join(directory, 'config.json')
    // A "future" config this build cannot validate, e.g. after a downgrade.
    const original = JSON.stringify({
      schemaVersion: 18,
      providers: 'not-an-array',
    })
    await writeFile(configPath, original, 'utf8')
    const secretStore = new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    )
    const store = new ConfigStore(configPath, secretStore)

    await expect(store.initialize()).resolves.toMatchObject({
      config: { schemaVersion: 18 },
    })

    const backups = (await readdir(directory)).filter((name) =>
      name.startsWith('config.json.unsupported-'),
    )
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(directory, backups[0]!), 'utf8')).toBe(
      original,
    )
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 18,
    })
  })

  it('migrates valid v9 providers to v18 without losing saved state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const configPath = path.join(directory, 'config.json')
    const legacy = structuredClone(legacyAppConfigV9) as Record<string, unknown>
    const providers = legacy.providers as Array<Record<string, unknown>>
    Object.assign(providers[0]!, {
      revision: 7,
      apiKeyRef: 'provider-key:legacy',
      modelCatalog: [{ id: 'deepseek-v4-pro', ownedBy: 'deepseek' }],
      modelOverrides: {
        'deepseek-v4-pro': { contextWindowTokens: 128_000 },
      },
    })
    providers.push({
      ...providers[0]!,
      id: 'generic',
      label: 'Generic',
      adapterId: 'openai-compatible.chat-completions',
      profile: 'generic',
      apiKeyRef: 'provider-key:generic',
      model: 'generic-model',
      modelCatalog: [{ id: 'generic-model' }],
      modelOverrides: {},
    })
    await writeFile(configPath, JSON.stringify(legacy), 'utf8')
    const store = new ConfigStore(
      configPath,
      new SecretStore(
        path.join(directory, 'secrets.json'),
        new FakeSafeStorage(),
      ),
    )
    await store.initialize()

    expect(store.getInternalConfig()).toMatchObject({
      schemaVersion: 18,
      modelPool: { entries: [] },
      providers: [
        {
          providerType: 'deepseek.chat-completions',
          revision: 7,
          apiKeyRef: 'provider-key:legacy',
          modelCatalog: [{ id: 'deepseek-v4-pro', ownedBy: 'deepseek' }],
          modelOverrides: {
            'deepseek-v4-pro': { contextWindowTokens: 128_000 },
          },
          enabledModelIds: ['deepseek-v4-pro'],
        },
        {
          providerType: 'generic.chat-completions',
          apiKeyRef: 'provider-key:generic',
          modelCatalog: [{ id: 'generic-model' }],
          enabledModelIds: ['generic-model'],
        },
      ],
    })
    const persisted = await readFile(configPath, 'utf8')
    expect(persisted).toContain('"schemaVersion": 18')
    expect(persisted).not.toContain('adapterId')
    expect(persisted).not.toContain('"profile"')
  })

  it('resets a malformed v9 file to clean v18 defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const configPath = path.join(directory, 'config.json')
    const malformed = structuredClone(legacyAppConfigV9) as Record<
      string,
      unknown
    >
    delete malformed.limits
    await writeFile(configPath, JSON.stringify(malformed), 'utf8')
    const store = new ConfigStore(
      configPath,
      new SecretStore(
        path.join(directory, 'secrets.json'),
        new FakeSafeStorage(),
      ),
    )

    await expect(store.initialize()).resolves.toMatchObject({
      config: { schemaVersion: 18 },
    })
    expect(store.getInternalConfig()).toEqual(DEFAULT_APP_CONFIG)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(
      DEFAULT_APP_CONFIG,
    )
  })

  it('deletes an incompatible v14 shape and rebuilds clean defaults', async () => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    config.legacyField = true
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 18,
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).not.toHaveProperty(
      'legacyField',
    )
  })

  it('deletes malformed JSON and rebuilds clean defaults', async () => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    await writeFile(configPath, '{"schemaVersion":18', 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 18,
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 18,
      limits: { maxStepsPerRun: 0 },
    })
  })

  it.each([
    ['fileChangeHistoryBytes', 100_000_000],
    ['maxAttachmentContextTokens', 64_000],
  ])('resets a v14 file missing required limit %s', async (field, value) => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      limits: Record<string, unknown>
    }
    delete config.limits[field]
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 18,
      limits: { [field]: value },
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      limits: { [field]: value },
    })
  })

  it.each([999_999, 10_000_000_001])(
    'rejects an out-of-range FileChange history budget: %s',
    (fileChangeHistoryBytes) => {
      const validate = compileSchema(ConfigSetRequestSchema)
      const request = {
        version: 1,
        kind: 'limits',
        value: {
          ...DEFAULT_APP_CONFIG.limits,
          fileChangeHistoryBytes,
        },
      }
      expect(validate(request)).toBe(false)
    },
  )

  it('validates model pool request structure and bounds', () => {
    const validate = compileSchema(ConfigSetRequestSchema)
    const valid = {
      version: 1,
      kind: 'model-pool',
      value: { entries: [modelPoolEntry({ enabled: false })] },
      expectedProviderRevisions: [],
    }

    expect(validate(valid)).toBe(true)
    for (const reasoning of ['low', 'medium', 'xhigh'] as const) {
      expect(
        validate({
          ...valid,
          value: {
            entries: [modelPoolEntry({ enabled: false, reasoning })],
          },
        }),
      ).toBe(true)
    }
    expect(
      validate({
        ...valid,
        value: {
          entries: [modelPoolEntry({ enabled: false, maxParallel: 0 })],
        },
      }),
    ).toBe(false)
    expect(
      validate({
        ...valid,
        value: {
          entries: [
            { ...modelPoolEntry({ enabled: false }), capability: 'strong' },
          ],
        },
      }),
    ).toBe(false)
    expect(
      validate({
        ...valid,
        value: {
          entries: Array.from({ length: 65 }, (_, index) =>
            modelPoolEntry({ enabled: false, id: `entry-${index}` }),
          ),
        },
      }),
    ).toBe(false)
  })

  it('defends the store against structurally invalid direct model pool updates', async () => {
    const { configStore } = await createStores()
    const invalid = {
      version: 1,
      kind: 'model-pool',
      value: {
        entries: [modelPoolEntry({ enabled: false, maxParallel: 0 })],
      },
      expectedProviderRevisions: [],
    } as unknown as ConfigSetRequest

    await expect(configStore.update(invalid)).rejects.toThrow(
      'Invalid model pool',
    )
    expect(configStore.getPublicConfig().modelPool.entries).toEqual([])
  })

  it('normalizes and atomically persists a complete model pool', async () => {
    const { directory, configStore } = await createStores()
    const provider = await configurePoolProvider(configStore)
    const publicConfig = await configStore.update(
      modelPoolUpdate(provider, [
        modelPoolEntry({ id: ' e\u0301 ' }),
        modelPoolEntry({
          id: 'disabled-reference',
          enabled: false,
          providerId: 'removed-provider',
          model: 'removed-model',
        }),
      ]),
    )

    expect(publicConfig.modelPool.entries).toEqual([
      modelPoolEntry({ id: 'é' }),
      modelPoolEntry({
        id: 'disabled-reference',
        enabled: false,
        providerId: 'removed-provider',
        model: 'removed-model',
      }),
    ])
    const persisted = JSON.parse(
      await readFile(path.join(directory, 'config.json'), 'utf8'),
    ) as { modelPool: { entries: ModelPoolEntry[] } }
    expect(persisted.modelPool.entries).toEqual(publicConfig.modelPool.entries)
    expect(JSON.stringify(publicConfig.modelPool)).not.toContain('apiKeyRef')
    expect(JSON.stringify(publicConfig.modelPool)).not.toContain(
      'model-pool-secret',
    )
  })

  it('rejects the whole model pool update when any enabled entry is invalid', async () => {
    const { directory, configStore } = await createStores()
    const provider = await configurePoolProvider(configStore)
    const configPath = path.join(directory, 'config.json')
    const before = await readFile(configPath, 'utf8')

    await expect(
      configStore.update({
        version: 1,
        kind: 'model-pool',
        value: {
          entries: [
            modelPoolEntry(),
            modelPoolEntry({
              id: 'invalid-entry',
              providerId: 'missing-provider',
            }),
          ],
        },
        expectedProviderRevisions: [
          { providerId: provider.id, revision: provider.revision },
          { providerId: 'missing-provider', revision: 1 },
        ],
      }),
    ).rejects.toThrow('Provider is not configured: missing-provider')

    expect(configStore.getPublicConfig().modelPool.entries).toEqual([])
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('requires an exact, unique, current Provider revision list', async () => {
    const { configStore } = await createStores()
    const provider = await configurePoolProvider(configStore)
    const value = { entries: [modelPoolEntry()] }

    await expect(
      configStore.update({
        version: 1,
        kind: 'model-pool',
        value,
        expectedProviderRevisions: [],
      }),
    ).rejects.toThrow('Missing expected Provider revision')
    await expect(
      configStore.update({
        version: 1,
        kind: 'model-pool',
        value,
        expectedProviderRevisions: [
          { providerId: provider.id, revision: provider.revision },
          { providerId: provider.id, revision: provider.revision },
        ],
      }),
    ).rejects.toThrow('Duplicate expected Provider revision')
    await expect(
      configStore.update({
        version: 1,
        kind: 'model-pool',
        value,
        expectedProviderRevisions: [
          { providerId: provider.id, revision: provider.revision },
          { providerId: 'extra-provider', revision: 1 },
        ],
      }),
    ).rejects.toThrow('Unexpected Provider revision')
    await expect(
      configStore.update({
        version: 1,
        kind: 'model-pool',
        value,
        expectedProviderRevisions: [
          { providerId: provider.id, revision: provider.revision - 1 },
        ],
      }),
    ).rejects.toThrow('Provider configuration changed')
    expect(configStore.getPublicConfig().modelPool.entries).toEqual([])
  })

  it('validates enabled model, endpoint, and credential bindings before saving', async () => {
    const missingCredential = await createStores()
    const providerWithoutCredential = await configurePoolProvider(
      missingCredential.configStore,
      { credential: false },
    )
    await expect(
      missingCredential.configStore.update(
        modelPoolUpdate(providerWithoutCredential, [modelPoolEntry()]),
      ),
    ).rejects.toThrow('credential is not configured')

    const disabledModel = await createStores()
    const providerWithCredential = await configurePoolProvider(
      disabledModel.configStore,
    )
    await expect(
      disabledModel.configStore.update(
        modelPoolUpdate(providerWithCredential, [
          modelPoolEntry({ model: 'not-enabled' }),
        ]),
      ),
    ).rejects.toThrow('Model is not enabled')

    const unsafeEndpoint = await createStores()
    await configurePoolProvider(unsafeEndpoint.configStore)
    const current = unsafeEndpoint.configStore.getPublicConfig().providers[0]!
    await unsafeEndpoint.configStore.update({
      version: 1,
      kind: 'provider',
      providerId: current.id,
      baseURL: 'https://user:secret@provider.example/v1',
      model: current.model,
      enabledModelIds: current.enabledModelIds,
      reasoning: current.reasoning,
    })
    const unsafeProvider =
      unsafeEndpoint.configStore.getPublicConfig().providers[0]!
    await expect(
      unsafeEndpoint.configStore.update(
        modelPoolUpdate(unsafeProvider, [modelPoolEntry()]),
      ),
    ).rejects.toThrow('must not contain credentials')
  })

  it('requires enabled pool models to have a Provider capability annotation', async () => {
    const { configStore } = await createStores()
    const initial = configStore.getPublicConfig().providers[0]!
    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: initial.id,
      label: initial.label,
      providerType: initial.providerType,
      baseURL: 'https://provider.example/v1',
      model: 'main-model',
      enabledModelIds: ['main-model', 'worker-model'],
      reasoning: 'high',
    })
    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: initial.id,
      action: 'set',
      apiKey: 'model-pool-secret',
    })
    const provider = configStore.getPublicConfig().providers[0]!

    await expect(
      configStore.update(modelPoolUpdate(provider, [modelPoolEntry()])),
    ).rejects.toThrow(
      'Model worker-model must have a capability annotation before it can be enabled in the model pool',
    )
    await expect(
      configStore.update(
        modelPoolUpdate(provider, [modelPoolEntry({ enabled: false })]),
      ),
    ).resolves.toMatchObject({
      modelPool: { entries: [{ enabled: false, model: 'worker-model' }] },
    })
  })

  it('shares reasoning compatibility between model pool saves and Provider edits', async () => {
    const { configStore } = await createStores()
    let provider = await configurePoolProvider(configStore)
    await configStore.update(
      modelPoolUpdate(provider, [modelPoolEntry({ reasoning: 'xhigh' })]),
    )

    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: provider.id,
      label: provider.label,
      providerType: provider.providerType,
      baseURL: provider.baseURL,
      model: provider.model,
      enabledModelIds: provider.enabledModelIds,
      modelOverrides: {
        'worker-model': {
          reasoningEfforts: ['low'],
          capability: 'standard',
        },
      },
      reasoning: provider.reasoning,
    })

    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      false,
    )
    provider = configStore.getPublicConfig().providers[0]!
    await expect(
      configStore.update(
        modelPoolUpdate(provider, [modelPoolEntry({ reasoning: 'xhigh' })]),
      ),
    ).rejects.toThrow(
      "does not support reasoning effort 'xhigh' (supported: low)",
    )
  })

  it('auto-disables pool entries when their Provider capability annotation is removed', async () => {
    const { configStore } = await createStores()
    const provider = await configurePoolProvider(configStore)
    await configStore.update(modelPoolUpdate(provider, [modelPoolEntry()]))

    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: provider.id,
      label: provider.label,
      providerType: provider.providerType,
      baseURL: provider.baseURL,
      model: provider.model,
      enabledModelIds: provider.enabledModelIds,
      modelOverrides: {},
      reasoning: provider.reasoning,
    })

    expect(configStore.getPublicConfig().modelPool.entries[0]).toMatchObject({
      enabled: false,
      model: 'worker-model',
    })
  })

  it('requires an explicit reasoning effort in approval config requests', () => {
    const validate = compileSchema(ConfigSetRequestSchema)
    const approval = {
      version: 1,
      kind: 'approval',
      approverProviderId: 'deepseek',
      approverModel: 'approval-model',
    }

    expect(validate(approval)).toBe(false)
    expect(validate({ ...approval, reasoning: 'off' })).toBe(true)
  })

  it('supports provider-scoped environment credentials for headless hosts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const secretStore = new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    )
    const store = new ConfigStore(
      path.join(directory, 'config.json'),
      secretStore,
      { environmentApiKeys: { generic: ' generic-secret ' } },
    )
    await store.initialize()
    await store.update({
      version: 1,
      kind: 'provider',
      providerId: 'generic',
      label: 'Generic',
      providerType: 'generic.chat-completions',
      baseURL: 'https://provider.invalid',
      model: 'generic-model',
      modelOverrides: {
        'generic-model': { capability: 'standard' },
      },
      reasoning: 'high',
    })

    expect(
      store
        .getPublicConfig()
        .providers.find((provider) => provider.id === 'generic')
        ?.credentialSource,
    ).toBe('environment')
    expect(
      store
        .getPublicConfig()
        .providers.find((provider) => provider.id === 'generic')?.revision,
    ).toBe(1)
    await expect(store.getProviderApiKey('generic')).resolves.toBe(
      'generic-secret',
    )
    const provider = store
      .getPublicConfig()
      .providers.find((candidate) => candidate.id === 'generic')!
    await expect(
      store.update(
        modelPoolUpdate(provider, [
          modelPoolEntry({
            providerId: 'generic',
            model: 'generic-model',
          }),
        ]),
      ),
    ).resolves.toMatchObject({
      modelPool: { entries: [{ enabled: true, providerId: 'generic' }] },
    })
  })

  it('persists credentials separately and only exposes configured state', async () => {
    const { directory, configStore } = await createStores()
    const apiKey = 'test-secret-key'
    const publicConfig = await configStore.update({
      version: 1,
      kind: 'credential',
      action: 'set',
      apiKey,
    })
    const configText = await readFile(
      path.join(directory, 'config.json'),
      'utf8',
    )
    const secretText = await readFile(
      path.join(directory, 'secrets.json'),
      'utf8',
    )
    const rendererText = JSON.stringify(publicConfig)

    expect(publicConfig.providers[0].credentialConfigured).toBe(true)
    expect(configText).not.toContain(apiKey)
    expect(secretText).not.toContain(apiKey)
    expect(rendererText).not.toContain(apiKey)
    expect(rendererText).not.toContain('apiKeyRef')
    expect(rendererText).not.toContain('encrypted:')
    await expect(configStore.getDeepSeekApiKey()).resolves.toBe(apiKey)
  })

  it('uses a non-persisted environment credential only when no stored key exists', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-env-'))
    const secretStore = new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    )
    const store = new ConfigStore(
      path.join(directory, 'config.json'),
      secretStore,
      { environmentApiKey: 'environment-secret' },
    )
    await store.initialize()

    expect(store.getPublicConfig().providers[0].credentialConfigured).toBe(true)
    await expect(store.getDeepSeekApiKey()).resolves.toBe('environment-secret')
    expect(
      await readFile(path.join(directory, 'config.json'), 'utf8'),
    ).not.toContain('environment-secret')

    await store.update({
      version: 1,
      kind: 'credential',
      action: 'set',
      apiKey: 'stored-secret',
    })
    await expect(store.getDeepSeekApiKey()).resolves.toBe('stored-secret')
  })

  it('writes v18 defaults atomically', async () => {
    const { directory, configStore } = await createStores()

    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      reasoning: 'off',
    })

    const parsed = JSON.parse(
      await readFile(path.join(directory, 'config.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(18)
    expect(configStore.getPublicConfig().limits.maxStepsPerRun).toBe(0)
    expect(configStore.getPublicConfig().limits.maxContextTokens).toBe(256_000)
    expect(configStore.getPublicConfig().limits.autoCompactTriggerPercent).toBe(
      80,
    )
    expect(configStore.getPublicConfig().limits.tokenEstimation).toEqual({
      mode: 'conservative',
      bytesPerToken: 3,
    })
  })

  it('persists Subagent settings without changing Provider revisions', async () => {
    const { directory, configStore } = await createStores()
    const revision = configStore.getPublicConfig().providers[0]!.revision

    const updated = await configStore.update({
      version: 1,
      kind: 'subagents',
      value: { enabled: true, workerTimeoutMs: 2_700_000 },
    })

    expect(updated.subagents).toEqual({
      enabled: true,
      workerTimeoutMs: 2_700_000,
    })
    expect(updated.providers[0]!.revision).toBe(revision)
    expect(
      JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')),
    ).toMatchObject({
      schemaVersion: 18,
      subagents: { enabled: true, workerTimeoutMs: 2_700_000 },
    })
  })

  it('increments provider revision only for route or credential changes', async () => {
    const { configStore } = await createStores()
    const initial = configStore.getPublicConfig().providers[0]!

    await configStore.setDeepSeekModelCatalog(
      [{ id: 'catalog-only', ownedBy: 'provider' }],
      '2026-07-23T00:00:00.000Z',
    )
    expect(configStore.getPublicConfig().providers[0]?.revision).toBe(
      initial.revision,
    )

    const selection = await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: initial.id,
      label: initial.label,
      providerType: initial.providerType,
      baseURL: initial.baseURL,
      model: 'catalog-only',
      enabledModelIds: ['catalog-only'],
      reasoning: initial.reasoning,
      limits: configStore.getPublicConfig().limits,
    })
    expect(selection.providers[0]).toMatchObject({
      enabledModelIds: ['catalog-only'],
      revision: initial.revision + 1,
    })
    const expandedPool = await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: initial.id,
      label: initial.label,
      providerType: initial.providerType,
      baseURL: initial.baseURL,
      model: 'catalog-only',
      enabledModelIds: ['catalog-only', 'secondary-model'],
      reasoning: initial.reasoning,
      limits: configStore.getPublicConfig().limits,
    })
    expect(expandedPool.providers[0]).toMatchObject({
      enabledModelIds: ['catalog-only', 'secondary-model'],
      revision: initial.revision + 1,
    })
    await configStore.setDeepSeekModelCatalog(
      [{ id: 'different-catalog-model' }],
      '2026-07-24T00:00:00.000Z',
    )
    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      enabledModelIds: ['catalog-only', 'secondary-model'],
      revision: initial.revision + 1,
    })

    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: initial.baseURL,
      model: 'revision-model',
      reasoning: initial.reasoning,
    })
    expect(configStore.getPublicConfig().providers[0]?.revision).toBe(
      initial.revision + 2,
    )

    await configStore.update({
      version: 1,
      kind: 'credential',
      action: 'set',
      apiKey: 'revision-secret',
    })
    expect(configStore.getPublicConfig().providers[0]?.revision).toBe(
      initial.revision + 3,
    )
  })

  it('detects Provider revision changes for route-freeze postflight checks', async () => {
    const { configStore } = await createStores()
    const initial = configStore.getPublicConfig().providers[0]!
    expect(() =>
      configStore.assertProviderRevisions([
        { providerId: initial.id, revision: initial.revision },
      ]),
    ).not.toThrow()

    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: initial.id,
      baseURL: 'https://revision-change.example/v1',
      model: initial.model,
      reasoning: initial.reasoning,
    })

    expect(() =>
      configStore.assertProviderRevisions([
        { providerId: initial.id, revision: initial.revision },
      ]),
    ).toThrow('Provider configuration changed while freezing route')
  })

  it('auto-disables entries when a model is removed and never auto-enables them', async () => {
    const { configStore } = await createStores()
    let provider = await configurePoolProvider(configStore)
    await configStore.update(modelPoolUpdate(provider, [modelPoolEntry()]))

    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: provider.id,
      label: provider.label,
      providerType: provider.providerType,
      baseURL: provider.baseURL,
      model: 'main-model',
      enabledModelIds: ['main-model'],
      reasoning: provider.reasoning,
      limits: configStore.getPublicConfig().limits,
    })
    expect(configStore.getPublicConfig().modelPool.entries[0]).toMatchObject({
      enabled: false,
      providerId: 'deepseek',
      model: 'worker-model',
    })

    provider = configStore.getPublicConfig().providers[0]!
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: provider.id,
      label: provider.label,
      providerType: provider.providerType,
      baseURL: provider.baseURL,
      model: 'main-model',
      enabledModelIds: ['main-model', 'worker-model'],
      reasoning: provider.reasoning,
      limits: configStore.getPublicConfig().limits,
    })
    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      false,
    )
  })

  it('auto-disables entries on explicit credential clear without restoring them', async () => {
    const { configStore } = await createStores()
    const provider = await configurePoolProvider(configStore)
    await configStore.update(modelPoolUpdate(provider, [modelPoolEntry()]))

    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: provider.id,
      action: 'clear',
    })
    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      false,
    )

    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: provider.id,
      action: 'set',
      apiKey: 'restored-secret',
    })
    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      false,
    )
  })

  it('keeps entries enabled across valid route edits and key replacement', async () => {
    const { configStore } = await createStores()
    let provider = await configurePoolProvider(configStore)
    await configStore.update(modelPoolUpdate(provider, [modelPoolEntry()]))

    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: provider.id,
      providerType: 'generic.responses',
      baseURL: 'https://replacement.example/v2',
      model: provider.model,
      enabledModelIds: provider.enabledModelIds,
      modelOverrides: {
        'worker-model': {
          contextWindowTokens: 128_000,
          capability: 'standard',
        },
      },
      reasoning: 'max',
    })
    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: provider.id,
      action: 'set',
      apiKey: 'replacement-secret',
    })

    provider = configStore.getPublicConfig().providers[0]!
    expect(provider.revision).toBeGreaterThan(1)
    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      true,
    )
  })

  it('auto-disables entries when their Provider is deleted and preserves them on recreation', async () => {
    const { configStore } = await createStores()
    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: 'worker-provider',
      label: 'Worker Provider',
      providerType: 'generic.chat-completions',
      baseURL: 'https://worker.example/v1',
      model: 'worker-model',
      enabledModelIds: ['worker-model'],
      modelOverrides: {
        'worker-model': { capability: 'standard' },
      },
      reasoning: 'high',
    })
    await configStore.update({
      version: 1,
      kind: 'credential',
      providerId: 'worker-provider',
      action: 'set',
      apiKey: 'worker-secret',
    })
    const provider = configStore
      .getPublicConfig()
      .providers.find((candidate) => candidate.id === 'worker-provider')!
    const entry = modelPoolEntry({
      providerId: provider.id,
      model: provider.model,
    })
    await configStore.update(modelPoolUpdate(provider, [entry]))

    await configStore.update({
      version: 1,
      kind: 'provider-delete',
      providerId: provider.id,
      fallbackProviderId: 'deepseek',
    })
    expect(configStore.getPublicConfig().modelPool.entries).toEqual([
      { ...entry, enabled: false },
    ])

    await configStore.update({
      version: 1,
      kind: 'provider',
      providerId: 'worker-provider',
      label: 'Recreated Worker',
      providerType: 'generic.chat-completions',
      baseURL: 'https://worker.example/v1',
      model: 'worker-model',
      enabledModelIds: ['worker-model'],
      reasoning: 'high',
    })
    expect(configStore.getPublicConfig().modelPool.entries[0]?.enabled).toBe(
      false,
    )
  })

  it('repairs handwritten dangling references but preserves temporary credential loss', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'))
    const configPath = path.join(directory, 'config.json')
    const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
    config.providers[0]!.model = 'main-model'
    config.providers[0]!.enabledModelIds = ['main-model']
    config.providers[0]!.modelOverrides = {
      'main-model': { capability: 'standard' },
    }
    config.modelPool.entries = [
      modelPoolEntry({
        id: 'missing-provider',
        providerId: 'removed-provider',
        model: 'preserved-model',
      }),
      modelPoolEntry({ id: 'missing-model' }),
      modelPoolEntry({
        id: 'credential-temporarily-missing',
        model: 'main-model',
      }),
    ]
    await writeFile(configPath, JSON.stringify(config), 'utf8')
    const store = new ConfigStore(
      configPath,
      new SecretStore(
        path.join(directory, 'secrets.json'),
        new FakeSafeStorage(),
      ),
    )

    await store.initialize()

    expect(
      store.getPublicConfig().modelPool.entries.map((entry) => entry.enabled),
    ).toEqual([false, false, true])
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
      modelPool: { entries: ModelPoolEntry[] }
    }
    expect(persisted.modelPool.entries.map((entry) => entry.enabled)).toEqual([
      false,
      false,
      true,
    ])
  })

  it('rejects a main model outside the enabled Provider pool', async () => {
    const { configStore } = await createStores()
    const provider = configStore.getPublicConfig().providers[0]!

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-settings',
        providerId: provider.id,
        label: provider.label,
        providerType: provider.providerType,
        baseURL: provider.baseURL,
        model: 'disabled-model',
        enabledModelIds: ['enabled-model'],
        reasoning: provider.reasoning,
        limits: configStore.getPublicConfig().limits,
      }),
    ).rejects.toThrow('Main model must be enabled')
  })

  it('preserves Provider Type when a later update omits it', async () => {
    const { configStore } = await createStores()
    const initial = configStore.getPublicConfig().providers[0]!
    await configStore.update({
      version: 1,
      kind: 'provider',
      providerType: 'generic.chat-completions',
      baseURL: initial.baseURL,
      model: initial.model,
      reasoning: initial.reasoning,
    })
    const provider = configStore.getPublicConfig().providers[0]!

    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: 'https://example.test/v1',
      model: provider.model,
      reasoning: provider.reasoning,
    })

    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      providerType: 'generic.chat-completions',
      revision: provider.revision + 1,
    })
  })

  it('reloads handwritten MCP config and resets unsupported schemas', async () => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    config.mcpServers = [
      {
        id: 'fixture',
        label: 'Fixture',
        description: 'Test MCP server',
        enabled: false,
        scope: 'global',
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        envFromHost: { TOKEN: 'MCP_TEST_TOKEN' },
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
      },
    ]
    await writeFile(configPath, JSON.stringify(config), 'utf8')
    await configStore.reloadFromDisk()

    expect(configStore.getMcpServers()).toHaveLength(1)
    expect(JSON.stringify(configStore.getPublicConfig())).not.toContain(
      'host-secret-value',
    )

    config.schemaVersion = 99
    await writeFile(configPath, JSON.stringify(config), 'utf8')
    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 18,
    })
    expect(configStore.getMcpServers()).toHaveLength(0)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 18,
      mcpServers: [],
    })
  })

  it('persists model catalogs and per-model capability overrides', async () => {
    const { configStore } = await createStores()
    await configStore.setDeepSeekModelCatalog(
      [{ id: 'model-a', ownedBy: 'provider' }],
      '2026-06-19T00:00:00.000Z',
    )
    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      reasoning: 'off',
      contextWindowTokens: 200_000,
      compactThresholdTokens: 150_000,
      maxOutputTokens: 10_000,
    })

    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      modelCatalog: [{ id: 'model-a', ownedBy: 'provider' }],
      modelCatalogFetchedAt: '2026-06-19T00:00:00.000Z',
      modelOverrides: {
        'model-a': {
          contextWindowTokens: 200_000,
          compactThresholdTokens: 150_000,
          maxOutputTokens: 10_000,
        },
      },
    })

    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      reasoning: 'off',
      contextWindowTokens: null,
      compactThresholdTokens: null,
      maxOutputTokens: null,
    })
    expect(configStore.getPublicConfig().providers[0].modelOverrides).toEqual(
      {},
    )
  })

  it('round-trips reasoning effort and capability annotations', async () => {
    const { directory, configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits

    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a', 'model-b'],
      reasoning: 'low',
      modelOverrides: {
        'model-a': { reasoningEfforts: ['low', 'medium'], capability: 'light' },
        'model-b': { capability: 'strong' },
      },
      limits,
    })

    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      modelOverrides: {
        'model-a': { reasoningEfforts: ['low', 'medium'], capability: 'light' },
        'model-b': { capability: 'strong' },
      },
    })

    // A second store instance must read the same annotations back from disk.
    const reloaded = new ConfigStore(
      path.join(directory, 'config.json'),
      new SecretStore(
        path.join(directory, 'secrets.json'),
        new FakeSafeStorage(),
      ),
    )
    const result = await reloaded.initialize()
    expect(result.config.providers[0]).toMatchObject({
      modelOverrides: {
        'model-a': { reasoningEfforts: ['low', 'medium'], capability: 'light' },
        'model-b': { capability: 'strong' },
      },
    })
  })

  it('bumps the provider revision when annotations change', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const base = {
      version: 1 as const,
      kind: 'provider-settings' as const,
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'low' as const,
      limits,
    }

    const created = await configStore.update({
      ...base,
      modelOverrides: { 'model-a': { reasoningEfforts: ['low', 'medium'] } },
    })
    const revision = created.providers[0]!.revision

    const annotated = await configStore.update({
      ...base,
      modelOverrides: {
        'model-a': { reasoningEfforts: ['low', 'medium'], capability: 'light' },
      },
    })
    expect(annotated.providers[0]!.revision).toBe(revision + 1)

    const unchanged = await configStore.update({
      ...base,
      modelOverrides: {
        'model-a': { reasoningEfforts: ['low', 'medium'], capability: 'light' },
      },
    })
    expect(unchanged.providers[0]!.revision).toBe(revision + 1)
  })

  it('rejects the whole update when the main model annotation excludes the provider reasoning', async () => {
    const { directory, configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'low',
      limits,
    })
    const persistedBefore = await readFile(
      path.join(directory, 'config.json'),
      'utf8',
    )

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-settings',
        baseURL: 'https://example.test/v1',
        model: 'model-a',
        enabledModelIds: ['model-a'],
        reasoning: 'high',
        modelOverrides: {
          'model-a': { reasoningEfforts: ['low', 'medium'] },
        },
        limits,
      }),
    ).rejects.toThrow('Provider reasoning must be supported by the main model')

    expect(await readFile(path.join(directory, 'config.json'), 'utf8')).toBe(
      persistedBefore,
    )
    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      reasoning: 'low',
      modelOverrides: {},
    })
  })

  it('validates and persists the exact approval reasoning effort', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a', 'model-b'],
      reasoning: 'off',
      modelOverrides: {
        'model-b': { reasoningEfforts: ['off', 'low'] },
      },
      limits,
    })

    await expect(
      configStore.update({
        version: 1,
        kind: 'approval',
        approverProviderId: providerId,
        approverModel: 'model-b',
        reasoning: 'high',
      }),
    ).rejects.toThrow('does not support approval reasoning effort')

    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'model-a',
      reasoning: 'off',
    })
    expect(configStore.getPublicConfig().approval).toEqual({
      approverProviderId: providerId,
      approverModel: 'model-a',
      reasoning: 'off',
    })
  })

  it('rejects a provider update that would break the saved approval model', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a', 'model-b'],
      reasoning: 'high',
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'model-b',
      reasoning: 'high',
    })

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-settings',
        baseURL: 'https://example.test/v1',
        model: 'model-a',
        enabledModelIds: ['model-a', 'model-b'],
        reasoning: 'high',
        modelOverrides: {
          'model-b': { reasoningEfforts: ['low'] },
        },
        limits,
      }),
    ).rejects.toThrow('does not support approval reasoning effort')
    expect(configStore.getPublicConfig().approval.approverModel).toBe('model-b')
    expect(configStore.getPublicConfig().providers[0]!.modelOverrides).toEqual(
      {},
    )
  })

  it('does not inherit Provider default reasoning into the saved approval route', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'main-model',
      enabledModelIds: ['main-model', 'approval-model'],
      reasoning: 'low',
      modelOverrides: {
        'main-model': { reasoningEfforts: ['low', 'high'] },
        'approval-model': { reasoningEfforts: ['off'] },
      },
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'approval-model',
      reasoning: 'off',
    })

    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'main-model',
      enabledModelIds: ['main-model', 'approval-model'],
      reasoning: 'high',
      modelOverrides: {
        'main-model': { reasoningEfforts: ['low', 'high'] },
        'approval-model': { reasoningEfforts: ['off'] },
      },
      limits,
    })

    expect(configStore.getPublicConfig()).toMatchObject({
      providers: [{ reasoning: 'high' }],
      approval: {
        approverProviderId: providerId,
        approverModel: 'approval-model',
        reasoning: 'off',
      },
    })
  })

  it('normalizes reasoning effort set order so equivalent annotations keep the revision', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'high',
      modelOverrides: {
        'model-a': { reasoningEfforts: ['max', 'low', 'high'] },
      },
      limits,
    })
    const provider = configStore.getPublicConfig().providers[0]!
    expect(provider.modelOverrides['model-a']!.reasoningEfforts).toEqual([
      'low',
      'high',
      'max',
    ])
    const revision = provider.revision

    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'high',
      modelOverrides: {
        'model-a': { reasoningEfforts: ['high', 'max', 'low'] },
      },
      limits,
    })
    expect(configStore.getPublicConfig().providers[0]!.revision).toBe(revision)
  })

  it('rejects approval saves with a missing provider, disabled model, or empty model', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'high',
      limits,
    })

    await expect(
      configStore.update({
        version: 1,
        kind: 'approval',
        approverProviderId: 'provider-missing',
        approverModel: 'model-a',
        reasoning: 'high',
      }),
    ).rejects.toThrow('Approval provider is not configured')
    await expect(
      configStore.update({
        version: 1,
        kind: 'approval',
        approverProviderId: providerId,
        approverModel: 'model-disabled',
        reasoning: 'high',
      }),
    ).rejects.toThrow('is not enabled for provider')
    await expect(
      configStore.update({
        version: 1,
        kind: 'approval',
        approverProviderId: providerId,
        approverModel: '',
        reasoning: 'high',
      }),
    ).rejects.toThrow('is not enabled for provider')
  })

  it('rejects a provider update that disables the saved approval model', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a', 'model-b'],
      reasoning: 'high',
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'model-b',
      reasoning: 'high',
    })

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-settings',
        baseURL: 'https://example.test/v1',
        model: 'model-a',
        enabledModelIds: ['model-a'],
        reasoning: 'high',
        limits,
      }),
    ).rejects.toThrow('is not enabled for provider')
    expect(configStore.getPublicConfig().approval.approverModel).toBe('model-b')
  })

  it('picks a compatible fallback approval model after deleting the approver provider', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'high',
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'fallback',
      label: 'Fallback',
      providerType: 'generic.chat-completions',
      baseURL: 'https://fallback.example/v1',
      model: 'fallback-low',
      enabledModelIds: ['fallback-low', 'fallback-high'],
      reasoning: 'low',
      modelOverrides: {
        'fallback-low': { reasoningEfforts: ['low'] },
        'fallback-high': { reasoningEfforts: ['high'] },
      },
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'model-a',
      reasoning: 'high',
    })

    await configStore.update({
      version: 1,
      kind: 'provider-delete',
      providerId,
      fallbackProviderId: 'fallback',
    })

    // Fallback selection uses the saved approval effort, not the fallback
    // Provider's own default effort, so it skips the low-only main model.
    expect(configStore.getPublicConfig().approval).toEqual({
      approverProviderId: 'fallback',
      approverModel: 'fallback-high',
      reasoning: 'high',
    })
  })

  it('rejects deleting the approver provider when the fallback has no compatible model', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    const providerId = configStore.getPublicConfig().activeProviderId
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a'],
      reasoning: 'high',
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'fallback',
      label: 'Fallback',
      providerType: 'generic.chat-completions',
      baseURL: 'https://fallback.example/v1',
      model: 'fallback-off',
      enabledModelIds: ['fallback-off'],
      reasoning: 'off',
      modelOverrides: {
        'fallback-off': { reasoningEfforts: ['off'] },
      },
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: providerId,
      approverModel: 'model-a',
      reasoning: 'high',
    })

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-delete',
        providerId,
        fallbackProviderId: 'fallback',
      }),
    ).rejects.toThrow(
      'No approval-compatible model is enabled for fallback provider fallback',
    )

    expect(configStore.getPublicConfig().providers.map(({ id }) => id)).toEqual(
      [providerId, 'fallback'],
    )
    expect(configStore.getPublicConfig().approval).toEqual({
      approverProviderId: providerId,
      approverModel: 'model-a',
      reasoning: 'high',
    })
  })

  it('persists localized assistant preferences', async () => {
    const { configStore } = await createStores()
    const result = await configStore.update({
      version: 1,
      kind: 'assistant',
      value: {
        language: 'en-US',
        preferences: {
          'zh-CN': '中文助手偏好',
          'en-US': 'Custom English preference',
        },
      },
    })

    expect(result.assistant).toEqual({
      language: 'en-US',
      preferences: {
        'zh-CN': '中文助手偏好',
        'en-US': 'Custom English preference',
      },
    })
  })

  it('commits provider settings without rewriting global approval', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits
    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-a',
      enabledModelIds: ['model-a', 'model-approver'],
      reasoning: 'off',
      limits,
    })
    await configStore.update({
      version: 1,
      kind: 'approval',
      approverProviderId: 'deepseek',
      approverModel: 'model-approver',
      reasoning: 'off',
    })

    const result = await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-b',
      reasoning: 'off',
      modelOverrides: {
        'model-b': {
          contextWindowTokens: 128_000,
          compactThresholdTokens: 96_000,
          maxOutputTokens: 8_000,
        },
        'model-c': {
          contextWindowTokens: 64_000,
          compactThresholdTokens: 44_000,
          maxOutputTokens: 8_000,
        },
      },
      limits: {
        ...limits,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 2.5 },
      },
      apiKey: 'atomic-secret',
    })

    expect(result.providers[0]).toMatchObject({
      baseURL: 'https://example.test/v1',
      model: 'model-b',
      reasoning: 'off',
      credentialConfigured: true,
      modelOverrides: {
        'model-b': {
          contextWindowTokens: 128_000,
          compactThresholdTokens: 96_000,
          maxOutputTokens: 8_000,
        },
        'model-c': {
          contextWindowTokens: 64_000,
          compactThresholdTokens: 44_000,
          maxOutputTokens: 8_000,
        },
      },
    })
    expect(result.approval.approverProviderId).toBe('deepseek')
    expect(result.approval.approverModel).toBe('model-approver')
    expect(result.approval.reasoning).toBe('off')
    expect(result.limits.tokenEstimation).toEqual({
      mode: 'custom-bytes',
      bytesPerToken: 2.5,
    })
    await expect(configStore.getDeepSeekApiKey()).resolves.toBe('atomic-secret')
  })

  it('rejects model settings whose compression threshold exceeds usable context', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-settings',
        baseURL: 'https://example.test/v1',
        model: 'model-a',
        reasoning: 'off',
        modelOverrides: {
          'model-a': {
            contextWindowTokens: 64_000,
            compactThresholdTokens: 60_000,
            maxOutputTokens: 8_000,
          },
        },
        limits,
      }),
    ).rejects.toThrow('Compression threshold exceeds the usable context')
  })

  it('selects, copies and deletes providers without copying secrets', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits

    await configStore.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'generic',
      label: 'Generic',
      providerType: 'generic.chat-completions',
      baseURL: 'https://generic.example/v1',
      model: 'generic-chat',
      reasoning: 'off',
      limits,
      apiKey: 'generic-secret',
    })
    await configStore.setProviderModelCatalog(
      'generic',
      [{ id: 'generic-chat' }, { id: 'generic-reasoner' }],
      '2026-06-25T00:00:00.000Z',
    )

    const selected = await configStore.update({
      version: 1,
      kind: 'provider-select',
      providerId: 'generic',
    })
    expect(selected.activeProviderId).toBe('generic')

    const copied = await configStore.update({
      version: 1,
      kind: 'provider-copy',
      sourceProviderId: 'generic',
      providerId: 'generic-copy',
      label: 'Generic Copy',
    })
    const copiedProvider = copied.providers.find(
      (provider) => provider.id === 'generic-copy',
    )
    expect(copiedProvider).toMatchObject({
      label: 'Generic Copy',
      baseURL: 'https://generic.example/v1',
      model: 'generic-chat',
      credentialConfigured: false,
      modelCatalog: [{ id: 'generic-chat' }, { id: 'generic-reasoner' }],
    })
    await expect(
      configStore.getProviderApiKey('generic-copy'),
    ).resolves.toBeUndefined()

    const deleted = await configStore.update({
      version: 1,
      kind: 'provider-delete',
      providerId: 'generic',
      fallbackProviderId: 'generic-copy',
    })
    expect(deleted.providers.map((provider) => provider.id)).toEqual([
      'deepseek',
      'generic-copy',
    ])
    expect(deleted.activeProviderId).toBe('generic-copy')
    expect(deleted.approval.approverProviderId).toBe('deepseek')
    await expect(
      configStore.getProviderApiKey('generic'),
    ).resolves.toBeUndefined()
  })

  it('refuses to delete the last provider', async () => {
    const { configStore } = await createStores()

    await expect(
      configStore.update({
        version: 1,
        kind: 'provider-delete',
        providerId: 'deepseek',
      }),
    ).rejects.toThrow('Cannot delete the last provider')
  })

  it('stores, masks and clears a web search API key', async () => {
    const { directory, configStore } = await createStores()

    expect(configStore.getPublicConfig().webSearch.credentialConfigured).toBe(
      false,
    )

    const config = await configStore.update({
      version: 1,
      kind: 'web-search-credential',
      action: 'set',
      apiKey: 'brave-key-secret',
    })
    expect(config.webSearch.credentialConfigured).toBe(true)
    expect(JSON.stringify(config)).not.toContain('brave-key-secret')

    const persisted = JSON.parse(
      await readFile(path.join(directory, 'config.json'), 'utf8'),
    ) as { webSearch: { apiKeyRef?: string } }
    expect(persisted.webSearch.apiKeyRef).toBeDefined()

    await expect(configStore.getWebSearchApiKey()).resolves.toBe(
      'brave-key-secret',
    )

    await configStore.update({
      version: 1,
      kind: 'web-search-credential',
      action: 'clear',
    })
    expect(configStore.getPublicConfig().webSearch.credentialConfigured).toBe(
      false,
    )
    await expect(configStore.getWebSearchApiKey()).resolves.toBeUndefined()
  })

  it('updates web search provider and count', async () => {
    const { configStore } = await createStores()

    const config = await configStore.update({
      version: 1,
      kind: 'web-search',
      provider: 'brave',
      count: 10,
    })
    expect(config.webSearch.provider).toBe('brave')
    expect(config.webSearch.count).toBe(10)
  })
})

describe('SecretStore availability', () => {
  it('rejects unavailable and Linux basic_text backends', async () => {
    const unavailable = new FakeSafeStorage()
    unavailable.available = false
    const unavailableStores = await createStores(unavailable)
    await expect(
      unavailableStores.secretStore.set('secret'),
    ).rejects.toBeInstanceOf(SecretStorageUnavailableError)

    const weak = new FakeSafeStorage('linux')
    weak.backend = 'basic_text'
    const weakStores = await createStores(weak)
    expect(weakStores.secretStore.status).toMatchObject({
      available: false,
      reason: 'weak_backend',
    })
  })

  it('reports temporary availability failure and encryption failure', async () => {
    const temporary = new FakeSafeStorage()
    temporary.failAvailability = true
    const stores = await createStores(temporary)

    expect(stores.secretStore.status).toMatchObject({
      available: false,
      reason: 'temporary_failure',
    })

    const encryptionFailure = new FakeSafeStorage()
    encryptionFailure.failEncryption = true
    const failingStores = await createStores(encryptionFailure)
    await expect(
      failingStores.secretStore.set('secret'),
    ).rejects.toBeInstanceOf(SecretStorageUnavailableError)
  })

  it('re-encrypts a secret after key rotation is reported', async () => {
    const adapter = new FakeSafeStorage()
    const { secretStore } = await createStores(adapter)
    const reference = await secretStore.set('rotating-secret')
    adapter.shouldReEncrypt = true

    await expect(secretStore.get(reference)).resolves.toBe('rotating-secret')
    expect(adapter.encryptions).toBe(2)
  })
})
