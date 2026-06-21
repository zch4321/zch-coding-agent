import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfigSetRequest, PublicConfig } from '../../shared/config'
import { writeJsonAtomic } from './atomic-file'
import { migrateConfig } from './migrations'
import { DEFAULT_APP_CONFIG, toPublicConfig, type AppConfig } from './schema'
import type { SecretStore, SecretStorageStatus } from './secret-store'

type ProviderUpdate = Extract<
  ConfigSetRequest,
  { kind: 'provider' | 'provider-settings' }
>

function applyProviderUpdate(next: AppConfig, request: ProviderUpdate): void {
  next.providers.deepseek.baseURL = request.baseURL
  next.providers.deepseek.model = request.model
  next.providers.deepseek.reasoning = request.reasoning
  next.providers.deepseek.modelOverrides[request.model] = {
    ...next.providers.deepseek.modelOverrides[request.model],
  }

  if (request.contextWindowTokens === null) {
    delete next.providers.deepseek.modelOverrides[request.model]
      .contextWindowTokens
  } else if (request.contextWindowTokens !== undefined) {
    next.providers.deepseek.modelOverrides[request.model].contextWindowTokens =
      request.contextWindowTokens
  }

  if (request.maxOutputTokens === null) {
    delete next.providers.deepseek.modelOverrides[request.model].maxOutputTokens
  } else if (request.maxOutputTokens !== undefined) {
    next.providers.deepseek.modelOverrides[request.model].maxOutputTokens =
      request.maxOutputTokens
  }

  if (
    Object.keys(next.providers.deepseek.modelOverrides[request.model])
      .length === 0
  ) {
    delete next.providers.deepseek.modelOverrides[request.model]
  }
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
    const stored = this.#secretStore.has(
      this.#config.providers.deepseek.apiKeyRef,
    )
    return toPublicConfig(
      this.#config,
      stored || Boolean(this.#environmentApiKey),
      stored
        ? 'safe-storage'
        : this.#environmentApiKey
          ? 'environment'
          : 'none',
    )
  }

  getInternalConfig(): AppConfig {
    return structuredClone(this.#config)
  }

  async getDeepSeekApiKey(): Promise<string | undefined> {
    const reference = this.#config.providers.deepseek.apiKeyRef
    const stored = reference
      ? await this.#secretStore.get(reference)
      : undefined
    return stored ?? this.#environmentApiKey
  }

  update(request: ConfigSetRequest): Promise<PublicConfig> {
    const operation = this.#mutation.then(() => this.#apply(request))
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  setDeepSeekModelCatalog(
    models: AppConfig['providers']['deepseek']['modelCatalog'],
    fetchedAt: string,
  ): Promise<PublicConfig> {
    const operation = this.#mutation.then(async () => {
      const next = structuredClone(this.#config)
      next.providers.deepseek.modelCatalog = structuredClone(models)
      next.providers.deepseek.modelCatalogFetchedAt = fetchedAt
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

  async #apply(request: ConfigSetRequest): Promise<PublicConfig> {
    const next = structuredClone(this.#config)

    switch (request.kind) {
      case 'provider':
        applyProviderUpdate(next, request)
        break
      case 'provider-settings': {
        applyProviderUpdate(next, request)
        next.approval = {
          approverProvider: request.approverProvider,
          approverModel: request.approverModel,
        }
        next.limits = structuredClone(request.limits)

        if (request.apiKey === undefined) {
          break
        }

        const previousReference = next.providers.deepseek.apiKeyRef
        const newReference = await this.#secretStore.set(request.apiKey)
        next.providers.deepseek.apiKeyRef = newReference

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
      case 'credential': {
        const previousReference = next.providers.deepseek.apiKeyRef

        if (request.action === 'clear') {
          delete next.providers.deepseek.apiKeyRef
          await writeJsonAtomic(this.#filePath, next)
          this.#config = next
          await this.#secretStore.delete(previousReference)
          return this.getPublicConfig()
        }

        const newReference = await this.#secretStore.set(request.apiKey)
        next.providers.deepseek.apiKeyRef = newReference

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
          approverProvider: request.approverProvider,
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
