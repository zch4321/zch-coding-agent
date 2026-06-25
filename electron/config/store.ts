import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfigSetRequest, PublicConfig } from '../../shared/config'
import { writeJsonAtomic } from './atomic-file'
import { migrateConfig } from './migrations'
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_PROVIDER_ID,
  getActiveAppProvider,
  getAppProvider,
  toPublicConfig,
  type AppConfig,
  type AppProviderConfig,
} from './schema'
import type { SecretStore, SecretStorageStatus } from './secret-store'

type ProviderUpdate = Extract<
  ConfigSetRequest,
  { kind: 'provider' | 'provider-settings' }
>

function applyProviderUpdate(
  next: AppConfig,
  request: ProviderUpdate,
  options: { activate: boolean },
): void {
  const providerId = request.providerId ?? next.activeProviderId
  let provider = getAppProvider(next, providerId)

  if (!provider) {
    provider = {
      id: providerId,
      label: request.label ?? providerId,
      protocol: 'openai-compatible',
      profile: request.profile ?? 'generic',
      baseURL: request.baseURL,
      model: request.model,
      reasoning: request.reasoning,
      modelCatalog: [],
      modelOverrides: {},
    }
    next.providers.push(provider)
  }

  provider.label = request.label ?? provider.label
  provider.profile = request.profile ?? provider.profile
  provider.baseURL = request.baseURL
  provider.model = request.model
  provider.reasoning = request.reasoning
  provider.modelOverrides[request.model] = {
    ...provider.modelOverrides[request.model],
  }

  if (request.contextWindowTokens === null) {
    delete provider.modelOverrides[request.model].contextWindowTokens
  } else if (request.contextWindowTokens !== undefined) {
    provider.modelOverrides[request.model].contextWindowTokens =
      request.contextWindowTokens
  }

  if (request.maxOutputTokens === null) {
    delete provider.modelOverrides[request.model].maxOutputTokens
  } else if (request.maxOutputTokens !== undefined) {
    provider.modelOverrides[request.model].maxOutputTokens =
      request.maxOutputTokens
  }

  if (Object.keys(provider.modelOverrides[request.model]).length === 0) {
    delete provider.modelOverrides[request.model]
  }

  if (options.activate) {
    next.activeProviderId = provider.id
  }
}

function providerFallback(
  next: AppConfig,
  preferredProviderId?: string,
): AppProviderConfig | undefined {
  return (
    (preferredProviderId
      ? getAppProvider(next, preferredProviderId)
      : undefined) ??
    getAppProvider(next, next.activeProviderId) ??
    next.providers[0]
  )
}

export class ConfigStore {
  readonly #filePath: string
  readonly #secretStore: SecretStore
  readonly #environmentApiKey: string | undefined
  #config: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
  #mutation = Promise.resolve()

  constructor(
    filePath: string,
    secretStore: SecretStore,
    options: { environmentApiKey?: string } = {},
  ) {
    this.#filePath = filePath
    this.#secretStore = secretStore
    this.#environmentApiKey = options.environmentApiKey?.trim() || undefined
  }

  async initialize(): Promise<{
    config: PublicConfig
    secretStorage: SecretStorageStatus
  }> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
    const secretStorage = await this.#secretStore.initialize()
    this.#config = await this.#read()

    return {
      config: this.getPublicConfig(),
      secretStorage,
    }
  }

  getPublicConfig(): PublicConfig {
    return toPublicConfig(
      this.#config,
      (provider) => {
        const stored = this.#secretStore.has(provider.apiKeyRef)
        const environment =
          provider.id === DEFAULT_PROVIDER_ID
            ? Boolean(this.#environmentApiKey)
            : false
        return {
          credentialConfigured: stored || environment,
          credentialSource: stored
            ? 'safe-storage'
            : environment
              ? 'environment'
              : 'none',
        }
      },
      undefined,
      this.#webSearchCredential(),
    )
  }

  getInternalConfig(): AppConfig {
    return structuredClone(this.#config)
  }

  async getDeepSeekApiKey(): Promise<string | undefined> {
    return this.getProviderApiKey(DEFAULT_PROVIDER_ID)
  }

  async getProviderApiKey(providerId: string): Promise<string | undefined> {
    const provider = getAppProvider(this.#config, providerId)
    const reference = provider?.apiKeyRef
    const stored = reference
      ? await this.#secretStore.get(reference)
      : undefined
    const environment =
      provider?.id === DEFAULT_PROVIDER_ID ? this.#environmentApiKey : undefined
    return stored ?? environment
  }

  async getWebSearchApiKey(): Promise<string | undefined> {
    const reference = this.#config.webSearch.apiKeyRef
    return reference ? this.#secretStore.get(reference) : undefined
  }

  #webSearchCredential(): Pick<
    PublicConfig['webSearch'],
    'credentialConfigured' | 'credentialSource'
  > {
    const configured = this.#config.webSearch.apiKeyRef
      ? this.#secretStore.has(this.#config.webSearch.apiKeyRef)
      : false
    return {
      credentialConfigured: configured,
      credentialSource: configured ? 'safe-storage' : 'none',
    }
  }

  getActiveProvider(): AppProviderConfig {
    return structuredClone(getActiveAppProvider(this.#config))
  }

  update(request: ConfigSetRequest): Promise<PublicConfig> {
    const operation = this.#mutation.then(() => this.#apply(request))
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  setProviderModelCatalog(
    providerId: string,
    models: AppProviderConfig['modelCatalog'],
    fetchedAt: string,
  ): Promise<PublicConfig> {
    const operation = this.#mutation.then(async () => {
      const next = structuredClone(this.#config)
      const provider = getAppProvider(next, providerId)

      if (!provider) {
        throw new Error(`Provider not found: ${providerId}`)
      }

      provider.modelCatalog = structuredClone(models)
      provider.modelCatalogFetchedAt = fetchedAt
      await writeJsonAtomic(this.#filePath, next)
      this.#config = next
      return this.getPublicConfig()
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  setDeepSeekModelCatalog(
    models: AppProviderConfig['modelCatalog'],
    fetchedAt: string,
  ): Promise<PublicConfig> {
    return this.setProviderModelCatalog(DEFAULT_PROVIDER_ID, models, fetchedAt)
  }

  async #apply(request: ConfigSetRequest): Promise<PublicConfig> {
    const next = structuredClone(this.#config)

    switch (request.kind) {
      case 'provider':
        applyProviderUpdate(next, request, { activate: true })
        break
      case 'provider-settings': {
        applyProviderUpdate(next, request, { activate: false })
        next.approval = {
          approverProviderId: request.approverProviderId,
          approverModel: request.approverModel,
        }
        next.limits = structuredClone(request.limits)

        if (request.apiKey === undefined) {
          break
        }

        const provider =
          getAppProvider(next, request.providerId ?? next.activeProviderId) ??
          getActiveAppProvider(next)
        const previousReference = provider.apiKeyRef
        const newReference = await this.#secretStore.set(request.apiKey)
        provider.apiKeyRef = newReference

        try {
          await writeJsonAtomic(this.#filePath, next)
        } catch (error) {
          await this.#secretStore.delete(newReference).catch(() => undefined)
          throw error
        }

        this.#config = next
        await this.#secretStore.delete(previousReference)
        return this.getPublicConfig()
      }
      case 'provider-select': {
        const provider = getAppProvider(next, request.providerId)

        if (!provider) {
          throw new Error(`Provider not found: ${request.providerId}`)
        }

        next.activeProviderId = provider.id
        break
      }
      case 'provider-copy': {
        const source = getAppProvider(next, request.sourceProviderId)

        if (!source) {
          throw new Error(`Provider not found: ${request.sourceProviderId}`)
        }

        if (getAppProvider(next, request.providerId)) {
          throw new Error(`Provider already exists: ${request.providerId}`)
        }

        const copy = structuredClone(source)
        delete copy.apiKeyRef
        next.providers.push({
          ...copy,
          id: request.providerId,
          label: request.label,
        })
        break
      }
      case 'provider-delete': {
        if (next.providers.length <= 1) {
          throw new Error('Cannot delete the last provider')
        }

        const provider = getAppProvider(next, request.providerId)

        if (!provider) {
          throw new Error(`Provider not found: ${request.providerId}`)
        }

        const previousReference = provider.apiKeyRef
        next.providers = next.providers.filter(
          (candidate) => candidate.id !== request.providerId,
        )
        const fallback = providerFallback(next, request.fallbackProviderId)

        if (!fallback) {
          throw new Error('No provider is available after deletion')
        }

        if (next.activeProviderId === request.providerId) {
          next.activeProviderId = fallback.id
        }

        if (next.approval.approverProviderId === request.providerId) {
          next.approval = {
            approverProviderId: fallback.id,
            approverModel: fallback.model,
          }
        }

        await writeJsonAtomic(this.#filePath, next)
        this.#config = next
        await this.#secretStore.delete(previousReference)
        return this.getPublicConfig()
      }
      case 'credential': {
        const provider =
          getAppProvider(next, request.providerId ?? next.activeProviderId) ??
          getActiveAppProvider(next)
        const previousReference = provider.apiKeyRef

        if (request.action === 'clear') {
          delete provider.apiKeyRef
          await writeJsonAtomic(this.#filePath, next)
          this.#config = next
          await this.#secretStore.delete(previousReference)
          return this.getPublicConfig()
        }

        const newReference = await this.#secretStore.set(request.apiKey)
        provider.apiKeyRef = newReference

        try {
          await writeJsonAtomic(this.#filePath, next)
        } catch (error) {
          await this.#secretStore.delete(newReference).catch(() => undefined)
          throw error
        }

        this.#config = next
        await this.#secretStore.delete(previousReference)
        return this.getPublicConfig()
      }
      case 'approval':
        next.approval = {
          approverProviderId: request.approverProviderId,
          approverModel: request.approverModel,
        }
        break
      case 'permission':
        next.permission = {
          defaultMode: request.defaultMode,
          builtinPolicies: request.builtinPolicies,
          rememberedRules: structuredClone(request.rememberedRules),
          sensitiveData: structuredClone(request.sensitiveData),
        }
        break
      case 'limits':
        next.limits = structuredClone(request.value)
        break
      case 'logging':
        next.logging = structuredClone(request.value)
        break
      case 'privacy':
        next.privacy = {
          providerNoticeAccepted: request.providerNoticeAccepted
            ? structuredClone(request.providerNoticeAccepted)
            : next.privacy.providerNoticeAccepted,
          traceNoticeAccepted: request.traceNoticeAccepted
            ? structuredClone(request.traceNoticeAccepted)
            : next.privacy.traceNoticeAccepted,
          yoloNoticeAccepted: request.yoloNoticeAccepted
            ? structuredClone(request.yoloNoticeAccepted)
            : next.privacy.yoloNoticeAccepted,
        }
        break
      case 'workspace':
        next.workspace =
          request.lastOpened === undefined
            ? {}
            : { lastOpened: request.lastOpened }
        break
      case 'skills':
        next.skills = structuredClone(request.value)
        break
      case 'assistant':
        next.assistant = structuredClone(request.value)
        break
      case 'prompts':
        next.prompts = structuredClone(request.value)
        break
      case 'network':
        next.network = structuredClone(request.value)
        break
      case 'web-search': {
        next.webSearch = {
          provider: request.provider,
          count: request.count,
          apiKeyRef: next.webSearch.apiKeyRef,
        }
        break
      }
      case 'web-search-credential': {
        const previousReference = next.webSearch.apiKeyRef

        if (request.action === 'clear') {
          delete next.webSearch.apiKeyRef
          await writeJsonAtomic(this.#filePath, next)
          this.#config = next
          await this.#secretStore.delete(previousReference)
          return this.getPublicConfig()
        }

        if (!request.apiKey) {
          throw new Error('web-search-credential set requires an apiKey')
        }

        const newReference = await this.#secretStore.set(request.apiKey)
        next.webSearch.apiKeyRef = newReference

        try {
          await writeJsonAtomic(this.#filePath, next)
        } catch (error) {
          await this.#secretStore.delete(newReference).catch(() => undefined)
          throw error
        }

        this.#config = next
        await this.#secretStore.delete(previousReference)
        return this.getPublicConfig()
      }
    }

    await writeJsonAtomic(this.#filePath, next)
    this.#config = next
    return this.getPublicConfig()
  }

  async #read(): Promise<AppConfig> {
    try {
      const content = await readFile(this.#filePath, 'utf8')
      return migrateConfig(JSON.parse(content))
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        const defaults = migrateConfig(undefined)
        await writeJsonAtomic(this.#filePath, defaults)
        return defaults
      }

      throw error
    }
  }
}
