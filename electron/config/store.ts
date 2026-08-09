import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  ModelPoolConfigSchema,
  normalizeModelPoolConfig,
  type ConfigSetRequest,
  type ModelPoolConfig,
  type PublicConfig,
} from '../../shared/config'
import {
  assertModelRouteSnapshotSafe,
  evaluateModelRouteCompatibility,
} from '../../shared/model-route'
import { normalizeReasoningEfforts } from '../../shared/model-settings'
import { writeJsonAtomic } from './atomic-file'
import { migrateConfig, UnsupportedConfigSchemaError } from './migrations'
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
import type { McpLaunchTrust, McpServerConfig } from '../../shared/mcp'
import { resolveModelProfiles } from '../providers/model-catalog'
import { resolveProviderEndpoint } from '../providers/provider-factory'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

type ProviderUpdate = Extract<
  ConfigSetRequest,
  { kind: 'provider' | 'provider-settings' }
>
type ModelPoolUpdate = Extract<ConfigSetRequest, { kind: 'model-pool' }>

const validateModelPoolConfig = compileSchema(ModelPoolConfigSchema)

function assertModelOverridesValid(
  overrides: AppProviderConfig['modelOverrides'],
): void {
  for (const [model, settings] of Object.entries(overrides)) {
    const context = settings.contextWindowTokens
    const output = settings.maxOutputTokens
    const threshold = settings.compactThresholdTokens

    if (context !== undefined && output !== undefined && output >= context) {
      throw new Error(
        `Maximum output length must be smaller than maximum context for model: ${model}`,
      )
    }
    if (
      context !== undefined &&
      threshold !== undefined &&
      threshold > context - (output ?? 0)
    ) {
      throw new Error(
        `Compression threshold exceeds the usable context for model: ${model}`,
      )
    }
  }
}

function normalizedEnabledModelIds(modelIds: readonly string[]): string[] {
  return [...new Set(modelIds.map((modelId) => modelId.trim()).filter(Boolean))]
}

/** Adds one configured model and makes it available to runtime selectors. */
function addProviderModel(
  provider: AppProviderConfig,
  modelId: string,
  modelOverride?: AppProviderConfig['modelOverrides'][string],
): void {
  const normalizedModelId = modelId.trim()
  if (!normalizedModelId) throw new Error('Model name is required')

  if (!provider.modelCatalog.some((model) => model.id === normalizedModelId)) {
    if (provider.modelCatalog.length >= 1_000) {
      throw new Error(
        'Provider model list cannot contain more than 1000 models',
      )
    }
    provider.modelCatalog.push({ id: normalizedModelId })
  }

  if (!provider.enabledModelIds.includes(normalizedModelId)) {
    if (provider.enabledModelIds.length >= 1_000) {
      throw new Error('Enabled model list cannot contain more than 1000 models')
    }
    provider.enabledModelIds.push(normalizedModelId)
  }

  if (!provider.model) provider.model = normalizedModelId

  if (modelOverride !== undefined) {
    const normalizedOverride = structuredClone(modelOverride)
    if (normalizedOverride.reasoningEfforts?.length) {
      normalizedOverride.reasoningEfforts = normalizeReasoningEfforts(
        normalizedOverride.reasoningEfforts,
      )
    }
    provider.modelOverrides[normalizedModelId] = normalizedOverride
    assertModelOverridesValid(provider.modelOverrides)
  }
}

/** Validates the configured main route while allowing an unconfigured model. */
function assertMainRouteConfigValid(provider: AppProviderConfig): void {
  if (!provider.model) return
  const compatibility = evaluateModelRouteCompatibility(provider, {
    model: provider.model,
    reasoning: provider.reasoning,
  })
  if (compatibility.ok) return
  if (compatibility.reason === 'model-disabled') {
    throw new Error('Main model must be enabled for the Provider')
  }
  if (compatibility.reason === 'reasoning-unsupported') {
    throw new Error(
      `Provider reasoning must be supported by the main model: ${provider.model}`,
    )
  }
  throw new Error(`Invalid main model route: ${compatibility.reason}`)
}

/** Returns the first enabled model compatible with one explicit effort. */
function firstApprovalCompatibleModel(
  provider: AppProviderConfig,
  reasoning: AppConfig['approval']['reasoning'],
): string | undefined {
  return provider.enabledModelIds.find(
    (model) =>
      evaluateModelRouteCompatibility(provider, { model, reasoning }).ok,
  )
}

/** True when the approval route currently resolves to a usable route. */
function isApprovalRouteUsable(
  config: AppConfig,
  approval: AppConfig['approval'],
): boolean {
  const provider = config.providers.find(
    (candidate) => candidate.id === approval.approverProviderId,
  )
  return evaluateModelRouteCompatibility(provider, {
    model: approval.approverModel,
    reasoning: approval.reasoning,
  }).ok
}

/**
 * Validates that an approval route can actually be resolved: the provider
 * exists, the model is non-empty and still enabled, and its explicitly saved
 * approval effort is supported by the model annotation. Used when saving
 * approval settings, and to stop provider updates from breaking a previously
 * working approval route.
 */
function assertApprovalRouteConfigValid(
  config: AppConfig,
  approval: AppConfig['approval'],
): void {
  const provider = config.providers.find(
    (candidate) => candidate.id === approval.approverProviderId,
  )
  const compatibility = evaluateModelRouteCompatibility(provider, {
    model: approval.approverModel,
    reasoning: approval.reasoning,
  })
  if (compatibility.ok) return
  if (compatibility.reason === 'provider-missing') {
    throw new Error(
      `Approval provider is not configured: ${approval.approverProviderId}`,
    )
  }
  if (
    compatibility.reason === 'model-empty' ||
    compatibility.reason === 'model-disabled'
  ) {
    throw new Error(
      `Approval model ${approval.approverModel || '(empty)'} is not enabled for provider ${approval.approverProviderId}`,
    )
  }
  throw new Error(
    `Approval model ${approval.approverModel} does not support approval reasoning effort: ${approval.reasoning}`,
  )
}

function applyProviderUpdate(
  next: AppConfig,
  request: ProviderUpdate,
  options: { activate: boolean },
): void {
  const providerId = request.providerId ?? next.activeProviderId
  let provider = getAppProvider(next, providerId)
  const isNewProvider = !provider
  // Snapshot approval usability before mutating: updates may not break a
  // working approval route, but an already unconfigured or broken approval
  // must not block unrelated provider edits.
  const approvalWasUsable = isApprovalRouteUsable(next, next.approval)

  if (!provider) {
    provider = {
      id: providerId,
      label: request.label ?? providerId,
      providerType: request.providerType ?? 'generic.chat-completions',
      revision: 1,
      baseURL: request.baseURL,
      model: request.model,
      reasoning: request.reasoning,
      modelCatalog: [],
      modelOverrides: {},
      enabledModelIds: normalizedEnabledModelIds(
        request.enabledModelIds ?? (request.model ? [request.model] : []),
      ),
    }
    next.providers.push(provider)
  }

  const previousRouteShape = providerRouteShape(provider)
  const previousProviderType = provider.providerType
  provider.label = request.label ?? provider.label
  provider.providerType = request.providerType ?? provider.providerType
  provider.baseURL = request.baseURL
  provider.model = request.model
  provider.reasoning = request.reasoning
  if (request.enabledModelIds !== undefined) {
    provider.enabledModelIds = normalizedEnabledModelIds(
      request.enabledModelIds,
    )
  } else if (
    request.model &&
    !provider.enabledModelIds.includes(request.model)
  ) {
    provider.enabledModelIds.push(request.model)
  }
  if (request.modelOverrides !== undefined) {
    // Normalize the effort set order so equivalent annotations cannot produce
    // spurious route-shape changes (and revision bumps).
    const normalized = structuredClone(request.modelOverrides)
    for (const override of Object.values(normalized)) {
      if (override.reasoningEfforts?.length) {
        override.reasoningEfforts = normalizeReasoningEfforts(
          override.reasoningEfforts,
        )
      }
    }
    provider.modelOverrides = normalized
  } else if (request.model) {
    provider.modelOverrides[request.model] = {
      ...provider.modelOverrides[request.model],
    }

    if (request.contextWindowTokens === null) {
      delete provider.modelOverrides[request.model].contextWindowTokens
    } else if (request.contextWindowTokens !== undefined) {
      provider.modelOverrides[request.model].contextWindowTokens =
        request.contextWindowTokens
    }

    if (request.compactThresholdTokens === null) {
      delete provider.modelOverrides[request.model].compactThresholdTokens
    } else if (request.compactThresholdTokens !== undefined) {
      provider.modelOverrides[request.model].compactThresholdTokens =
        request.compactThresholdTokens
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
  }
  assertModelOverridesValid(provider.modelOverrides)
  if (!isNewProvider && provider.providerType !== previousProviderType) {
    provider.modelCatalog = []
    delete provider.modelCatalogFetchedAt
  }
  assertMainRouteConfigValid(provider)
  if (approvalWasUsable && next.approval.approverProviderId === provider.id) {
    assertApprovalRouteConfigValid(next, next.approval)
  }
  if (!isNewProvider && providerRouteShape(provider) !== previousRouteShape) {
    provider.revision += 1
  }

  if (options.activate) {
    next.activeProviderId = provider.id
  }
}

function providerRouteShape(provider: AppProviderConfig): string {
  return JSON.stringify({
    providerType: provider.providerType,
    baseURL: provider.baseURL,
    model: provider.model,
    reasoning: provider.reasoning,
    modelOverrides: provider.modelOverrides,
    apiKeyRef: provider.apiKeyRef,
  })
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

function disableModelPoolEntries(
  config: AppConfig,
  shouldDisable: (entry: ModelPoolConfig['entries'][number]) => boolean,
): boolean {
  let changed = false
  config.modelPool.entries = config.modelPool.entries.map((entry) => {
    if (!entry.enabled || !shouldDisable(entry)) return entry
    changed = true
    return { ...entry, enabled: false }
  })
  return changed
}

function disableIncompatibleModelPoolEntries(config: AppConfig): boolean {
  return disableModelPoolEntries(config, (entry) => {
    const provider = getAppProvider(config, entry.providerId)
    return (
      !evaluateModelRouteCompatibility(provider, {
        model: entry.model,
        reasoning: entry.reasoning,
      }).ok || !provider?.modelOverrides[entry.model]?.capability
    )
  })
}

function assertModelPoolRevisionCoverage(
  config: PublicConfig,
  request: ModelPoolUpdate,
): void {
  const requiredProviderIds = new Set(
    request.value.entries
      .filter((entry) => entry.enabled)
      .map((entry) => entry.providerId),
  )
  const revisions = new Map<string, number>()

  for (const expected of request.expectedProviderRevisions) {
    if (revisions.has(expected.providerId)) {
      throw new Error(
        `Duplicate expected Provider revision: ${expected.providerId}`,
      )
    }
    if (!requiredProviderIds.has(expected.providerId)) {
      throw new Error(
        `Unexpected Provider revision for model pool: ${expected.providerId}`,
      )
    }
    revisions.set(expected.providerId, expected.revision)
  }

  for (const providerId of requiredProviderIds) {
    const expectedRevision = revisions.get(providerId)
    if (expectedRevision === undefined) {
      throw new Error(
        `Missing expected Provider revision for model pool: ${providerId}`,
      )
    }
    const provider = config.providers.find(
      (candidate) => candidate.id === providerId,
    )
    if (!provider) {
      throw new Error(`Provider is not configured: ${providerId}`)
    }
    if (provider.revision !== expectedRevision) {
      throw new Error(
        `Provider configuration changed before saving model pool: ${providerId}`,
      )
    }
  }
}

function assertEnabledModelPoolEntriesValid(
  config: PublicConfig,
  pool: ModelPoolConfig,
): void {
  for (const entry of pool.entries) {
    if (!entry.enabled) continue

    const provider = config.providers.find(
      (candidate) => candidate.id === entry.providerId,
    )
    if (!provider) {
      throw new Error(`Provider is not configured: ${entry.providerId}`)
    }
    const compatibility = evaluateModelRouteCompatibility(provider, {
      model: entry.model,
      reasoning: entry.reasoning,
    })
    if (!compatibility.ok) {
      if (
        compatibility.reason === 'model-empty' ||
        compatibility.reason === 'model-disabled'
      ) {
        throw new Error(
          `Model is not enabled for ${provider.label}: ${entry.model}`,
        )
      }
      if (compatibility.reason === 'reasoning-unsupported') {
        throw new Error(
          `Model ${entry.model} does not support reasoning effort '${entry.reasoning}' (supported: ${compatibility.supportedReasoningEfforts.join(', ')})`,
        )
      }
      throw new Error(`Invalid model pool route: ${compatibility.reason}`)
    }
    if (!provider.modelOverrides[entry.model]?.capability) {
      throw new Error(
        `Model ${entry.model} must have a capability annotation before it can be enabled in the model pool`,
      )
    }

    const endpoint = resolveProviderEndpoint(
      provider.providerType,
      provider.baseURL,
    )
    assertModelRouteSnapshotSafe({
      schemaVersion: 2,
      purpose: 'main',
      providerType: provider.providerType,
      providerId: provider.id,
      model: entry.model,
      reasoning: entry.reasoning,
      endpoint,
      providerConfigRevision: provider.revision,
    })
    const profile = resolveModelProfiles(config, provider.id, entry.model).find(
      (candidate) => candidate.id === entry.model,
    )
    if (!profile) {
      throw new Error(
        `Model profile is not available for ${provider.label}: ${entry.model}`,
      )
    }
    if (!provider.credentialConfigured) {
      throw new Error(`${provider.label} credential is not configured`)
    }
  }
}

/** Serializes configuration mutations, persists settings, and delegates credentials to SecretStore. */
export class ConfigStore {
  readonly #filePath: string
  readonly #secretStore: SecretStore
  readonly #environmentApiKeys: Readonly<Record<string, string>>
  #config: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
  #mutation = Promise.resolve()

  constructor(
    filePath: string,
    secretStore: SecretStore,
    options: {
      environmentApiKey?: string
      environmentApiKeys?: Record<string, string | undefined>
    } = {},
  ) {
    this.#filePath = filePath
    this.#secretStore = secretStore
    this.#environmentApiKeys = Object.fromEntries(
      Object.entries({
        ...(options.environmentApiKey
          ? { [DEFAULT_PROVIDER_ID]: options.environmentApiKey }
          : {}),
        ...options.environmentApiKeys,
      }).flatMap(([providerId, value]) => {
        const normalized = value?.trim()
        return normalized ? [[providerId, normalized]] : []
      }),
    )
  }

  /** Creates the config directory, loads and migrates settings, and initializes secret storage. */
  async initialize(): Promise<{
    config: PublicConfig
    secretStorage: SecretStorageStatus
  }> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
    const secretStorage = await this.#secretStore.initialize()
    const config = await this.#read()
    assertUniqueMcpServers(config)
    this.#config = config

    return {
      config: this.getPublicConfig(),
      secretStorage,
    }
  }

  /** Returns renderer-safe settings with credential presence and source but no secret values. */
  getPublicConfig(): PublicConfig {
    return this.#toPublicConfig(this.#config)
  }

  #toPublicConfig(config: AppConfig): PublicConfig {
    return toPublicConfig(
      config,
      (provider) => {
        const stored = this.#secretStore.has(provider.apiKeyRef)
        const environment = Boolean(this.#environmentApiKeys[provider.id])
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

  /** Returns a cloned privileged configuration including stored credential references. */
  getInternalConfig(): AppConfig {
    return structuredClone(this.#config)
  }

  /** Loads the credential for the default DeepSeek provider. */
  async getDeepSeekApiKey(): Promise<string | undefined> {
    return this.getProviderApiKey(DEFAULT_PROVIDER_ID)
  }

  /** Returns a provider credential from safe storage, falling back to its environment value. */
  async getProviderApiKey(providerId: string): Promise<string | undefined> {
    const provider = getAppProvider(this.#config, providerId)
    const reference = provider?.apiKeyRef
    const stored = reference
      ? await this.#secretStore.get(reference)
      : undefined
    const environment = provider
      ? this.#environmentApiKeys[provider.id]
      : undefined
    return stored ?? environment
  }

  /** Returns a provider credential only when its revision still matches the frozen route. */
  async getProviderApiKeyForRevision(
    providerId: string,
    revision: number,
  ): Promise<string | undefined> {
    const provider = getAppProvider(this.#config, providerId)
    if (!provider || provider.revision !== revision) {
      throw new Error(
        `Provider configuration changed while freezing route: ${providerId}`,
      )
    }
    const reference = provider.apiKeyRef
    const stored = reference
      ? await this.#secretStore.get(reference)
      : undefined
    return stored ?? this.#environmentApiKeys[provider.id]
  }

  /** Rejects when any Provider no longer matches a previously captured revision. */
  assertProviderRevisions(
    expected: readonly { providerId: string; revision: number }[],
  ): void {
    for (const item of expected) {
      const provider = getAppProvider(this.#config, item.providerId)
      if (!provider || provider.revision !== item.revision) {
        throw new Error(
          `Provider configuration changed while freezing route: ${item.providerId}`,
        )
      }
    }
  }

  /** Returns the stored credential for the configured web-search provider. */
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

  /** Returns a cloned configuration for the active provider. */
  getActiveProvider(): AppProviderConfig {
    return structuredClone(getActiveAppProvider(this.#config))
  }

  /** Returns cloned MCP server configurations for privileged callers. */
  getMcpServers(): McpServerConfig[] {
    return structuredClone(this.#config.mcpServers)
  }

  /** Reloads settings from disk behind the mutation queue and returns public configuration. */
  reloadFromDisk(): Promise<PublicConfig> {
    const operation = this.#mutation.then(async () => {
      const next = await this.#read()
      assertUniqueMcpServers(next)
      this.#config = next
      return this.getPublicConfig()
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /** Persists an MCP server's enabled flag and optional launch-trust decision. */
  setMcpServerEnabled(
    serverId: string,
    enabled: boolean,
    launchTrust?: McpLaunchTrust,
  ): Promise<PublicConfig> {
    const operation = this.#mutation.then(async () => {
      const next = structuredClone(this.#config)
      const server = next.mcpServers.find(
        (candidate) => candidate.id === serverId,
      )

      if (!server) {
        throw new Error(`MCP server not found: ${serverId}`)
      }

      server.enabled = enabled
      if (launchTrust) server.launchTrust = structuredClone(launchTrust)
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

  /** Serializes and persists a typed configuration update. */
  update(request: ConfigSetRequest): Promise<PublicConfig> {
    const operation = this.#mutation.then(() => this.#apply(request))
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /** Persists a fetched model catalog and timestamp for one provider. */
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

      const knownModelIds = new Set(
        provider.modelCatalog.map((model) => model.id),
      )
      const additions: AppProviderConfig['modelCatalog'] = []
      for (const model of models) {
        const modelId = model.id.trim()
        if (!modelId || knownModelIds.has(modelId)) continue
        if (provider.modelCatalog.length + additions.length >= 1_000) break
        additions.push({ ...structuredClone(model), id: modelId })
        knownModelIds.add(modelId)
      }
      provider.modelCatalog.push(...structuredClone(additions))
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

  /** Persists the fetched model catalog for the default DeepSeek provider. */
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
        disableIncompatibleModelPoolEntries(next)
        break
      case 'provider-settings': {
        applyProviderUpdate(next, request, { activate: false })
        disableIncompatibleModelPoolEntries(next)
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
        provider.revision += 1

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
      case 'provider-model-add': {
        const provider = getAppProvider(next, request.providerId)
        if (!provider) {
          throw new Error(`Provider not found: ${request.providerId}`)
        }
        const previousRouteShape = providerRouteShape(provider)
        addProviderModel(provider, request.modelId, request.modelOverride)
        assertMainRouteConfigValid(provider)
        if (providerRouteShape(provider) !== previousRouteShape) {
          provider.revision += 1
        }
        break
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
          revision: 1,
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
          const fallbackApprovalModel = next.approval.approverModel
            ? firstApprovalCompatibleModel(fallback, next.approval.reasoning)
            : undefined
          if (next.approval.approverModel && !fallbackApprovalModel) {
            throw new Error(
              `No approval-compatible model is enabled for fallback provider ${fallback.id}`,
            )
          }
          next.approval = {
            approverProviderId: fallback.id,
            approverModel: fallbackApprovalModel ?? '',
            reasoning: next.approval.reasoning,
          }
        }

        disableModelPoolEntries(
          next,
          (entry) => entry.providerId === request.providerId,
        )

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
          provider.revision += 1
          disableModelPoolEntries(
            next,
            (entry) => entry.providerId === provider.id,
          )
          await writeJsonAtomic(this.#filePath, next)
          this.#config = next
          await this.#secretStore.delete(previousReference)
          return this.getPublicConfig()
        }

        const newReference = await this.#secretStore.set(request.apiKey)
        provider.apiKeyRef = newReference
        provider.revision += 1

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
        assertApprovalRouteConfigValid(next, {
          approverProviderId: request.approverProviderId,
          approverModel: request.approverModel,
          reasoning: request.reasoning,
        })
        next.approval = {
          approverProviderId: request.approverProviderId,
          approverModel: request.approverModel,
          reasoning: request.reasoning,
        }
        break
      case 'subagents':
        next.subagents = structuredClone(request.value)
        break
      case 'model-pool': {
        if (!validateModelPoolConfig(request.value)) {
          throw new Error(
            `Invalid model pool: ${formatSchemaErrors(validateModelPoolConfig.errors)}`,
          )
        }
        const normalized = normalizeModelPoolConfig(request.value)
        const publicConfig = this.#toPublicConfig(next)
        assertModelPoolRevisionCoverage(publicConfig, {
          ...request,
          value: normalized,
        })
        assertEnabledModelPoolEntriesValid(publicConfig, normalized)
        next.modelPool = normalized
        break
      }
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
      const parsed = JSON.parse(content) as unknown
      const migrated = migrateConfig(parsed)
      disableIncompatibleModelPoolEntries(migrated)
      if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
        await writeJsonAtomic(this.#filePath, migrated)
      }
      return migrated
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

      if (
        error instanceof UnsupportedConfigSchemaError ||
        error instanceof SyntaxError
      ) {
        await this.#backupUnreadableConfig()
        await rm(this.#filePath, { force: true })
        const defaults = migrateConfig(undefined)
        await writeJsonAtomic(this.#filePath, defaults)
        return defaults
      }

      throw error
    }
  }

  /**
   * Preserves a config file this version cannot parse before the destructive
   * reset. Downgrades are unsupported; the backup is the only recovery path.
   * A failed backup must never block the reset itself.
   */
  async #backupUnreadableConfig(): Promise<void> {
    try {
      const stamp = new Date().toISOString().replaceAll(':', '-')
      await copyFile(
        this.#filePath,
        `${this.#filePath}.unsupported-${stamp}.bak`,
      )
    } catch {
      // Best effort only.
    }
  }
}

function assertUniqueMcpServers(config: AppConfig): void {
  const ids = new Set<string>()
  for (const server of config.mcpServers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate MCP server id: ${server.id}`)
    }
    ids.add(server.id)
  }
}
