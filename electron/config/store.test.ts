import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSetRequestSchema } from '../../shared/config'
import { compileSchema } from '../schema-validator'
import legacyAppConfigV9 from './fixtures/app-config-v9.json'
import { DEFAULT_APP_CONFIG } from './schema'
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

describe('ConfigStore', () => {
  it('deletes a legacy config and rebuilds clean v12 defaults', async () => {
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
      config: { schemaVersion: 12 },
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 12,
      limits: { maxStepsPerRun: 0 },
    })
  })

  it('migrates valid v9 providers to v12 without losing saved state', async () => {
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
      schemaVersion: 12,
      providers: [
        {
          providerType: 'deepseek.chat-completions',
          revision: 7,
          apiKeyRef: 'provider-key:legacy',
          modelCatalog: [{ id: 'deepseek-v4-pro', ownedBy: 'deepseek' }],
          modelOverrides: {
            'deepseek-v4-pro': { contextWindowTokens: 128_000 },
          },
          modelConfigurationIds: ['deepseek-v4-pro'],
        },
        {
          providerType: 'generic.chat-completions',
          apiKeyRef: 'provider-key:generic',
          modelCatalog: [{ id: 'generic-model' }],
          modelConfigurationIds: ['generic-model'],
        },
      ],
    })
    const persisted = await readFile(configPath, 'utf8')
    expect(persisted).toContain('"schemaVersion": 12')
    expect(persisted).not.toContain('adapterId')
    expect(persisted).not.toContain('"profile"')
  })

  it('resets a malformed v9 file to clean v12 defaults', async () => {
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
      config: { schemaVersion: 12 },
    })
    expect(store.getInternalConfig()).toEqual(DEFAULT_APP_CONFIG)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(
      DEFAULT_APP_CONFIG,
    )
  })

  it('deletes an incompatible v12 shape and rebuilds clean defaults', async () => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    config.legacyField = true
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 12,
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).not.toHaveProperty(
      'legacyField',
    )
  })

  it('deletes malformed JSON and rebuilds clean defaults', async () => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    await writeFile(configPath, '{"schemaVersion":12', 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 12,
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 12,
      limits: { maxStepsPerRun: 0 },
    })
  })

  it.each([
    ['fileChangeHistoryBytes', 100_000_000],
    ['maxAttachmentContextTokens', 64_000],
  ])('resets a v12 file missing required limit %s', async (field, value) => {
    const { directory, configStore } = await createStores()
    const configPath = path.join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      limits: Record<string, unknown>
    }
    delete config.limits[field]
    await writeFile(configPath, JSON.stringify(config), 'utf8')

    await expect(configStore.reloadFromDisk()).resolves.toMatchObject({
      schemaVersion: 12,
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

  it('writes v12 defaults atomically', async () => {
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
    expect(parsed.schemaVersion).toBe(12)
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
      kind: 'provider-model-configuration',
      providerId: initial.id,
      modelIds: ['catalog-only'],
    })
    expect(selection.providers[0]).toMatchObject({
      modelConfigurationIds: ['catalog-only'],
      revision: initial.revision,
    })
    await configStore.setDeepSeekModelCatalog(
      [{ id: 'different-catalog-model' }],
      '2026-07-24T00:00:00.000Z',
    )
    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      modelConfigurationIds: ['catalog-only'],
      revision: initial.revision,
    })

    await configStore.update({
      version: 1,
      kind: 'provider',
      baseURL: initial.baseURL,
      model: 'revision-model',
      reasoning: initial.reasoning,
    })
    expect(configStore.getPublicConfig().providers[0]?.revision).toBe(
      initial.revision + 1,
    )

    await configStore.update({
      version: 1,
      kind: 'credential',
      action: 'set',
      apiKey: 'revision-secret',
    })
    expect(configStore.getPublicConfig().providers[0]?.revision).toBe(
      initial.revision + 2,
    )
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
      schemaVersion: 12,
    })
    expect(configStore.getMcpServers()).toHaveLength(0)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      schemaVersion: 12,
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
      kind: 'approval',
      approverProviderId: 'deepseek',
      approverModel: 'model-approver',
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
