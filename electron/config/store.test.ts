import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

  it('migrates missing fields onto defaults and writes atomically', async () => {
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
    expect(parsed.schemaVersion).toBe(4)
    expect(configStore.getPublicConfig().limits.maxStepsPerRun).toBeGreaterThan(
      0,
    )
    expect(configStore.getPublicConfig().limits.tokenEstimation).toEqual({
      mode: 'conservative',
      bytesPerToken: 3,
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
      maxOutputTokens: 10_000,
    })

    expect(configStore.getPublicConfig().providers[0]).toMatchObject({
      modelCatalog: [{ id: 'model-a', ownedBy: 'provider' }],
      modelCatalogFetchedAt: '2026-06-19T00:00:00.000Z',
      modelOverrides: {
        'model-a': {
          contextWindowTokens: 200_000,
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
      maxOutputTokens: null,
    })
    expect(configStore.getPublicConfig().providers[0].modelOverrides).toEqual(
      {},
    )
  })

  it('persists localized configurable system prompts', async () => {
    const { configStore } = await createStores()
    const result = await configStore.update({
      version: 1,
      kind: 'assistant',
      value: {
        language: 'en-US',
        systemPrompts: {
          'zh-CN': '中文自定义提示词',
          'en-US': 'Custom English prompt',
        },
      },
    })

    expect(result.assistant).toEqual({
      language: 'en-US',
      systemPrompts: {
        'zh-CN': '中文自定义提示词',
        'en-US': 'Custom English prompt',
      },
    })
  })

  it('commits provider settings and an optional credential together', async () => {
    const { configStore } = await createStores()
    const limits = configStore.getPublicConfig().limits

    const result = await configStore.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://example.test/v1',
      model: 'model-b',
      reasoning: 'off',
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_000,
      approverProviderId: 'deepseek',
      approverModel: 'model-approver',
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
