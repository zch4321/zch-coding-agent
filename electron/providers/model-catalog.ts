import {
  getActiveProviderConfig,
  getProviderConfig,
  type ProviderType,
  type PublicConfig,
  type ProviderModel,
} from '../../shared/config'

const MAX_CATALOG_BYTES = 1_000_000
const MAX_MODELS = 1_000
const DEFAULT_TIMEOUT_MS = 15_000

interface BuiltinModelCapability {
  contextWindowTokens: number
  maxOutputTokens?: number
}

const BUILTIN_MODEL_CAPABILITIES: Readonly<
  Record<string, BuiltinModelCapability>
> = {
  'deepseek-v4-flash': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
  },
  'deepseek-v4-pro': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
  },
}

export interface ModelProfile {
  id: string
  ownedBy?: string
  availability: 'provider' | 'custom'
  capabilitySource: 'override' | 'builtin' | 'default'
  contextWindowTokens: number
  maxOutputTokens?: number
}

/** Reports model-catalog request, response, and normalization failures. */
export class ModelCatalogError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ModelCatalogError'
    this.status = status
  }
}

/** Normalizes a provider base URL and appends its OpenAI-compatible models path. */
export function modelCatalogEndpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('models', normalized).toString()
}

/** Fetches an OpenAI-compatible model list with authentication, timeout, and response bounds. */
export async function fetchOpenAICompatibleModelCatalog(options: {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ProviderModel[]> {
  const controller = new AbortController()
  const relayAbort = () => controller.abort(options.signal?.reason)
  const timer = setTimeout(
    () => controller.abort(new Error('Model catalog request timed out')),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  options.signal?.addEventListener('abort', relayAbort, { once: true })

  try {
    const response = await (options.fetchImpl ?? fetch)(
      modelCatalogEndpoint(options.baseURL),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        signal: controller.signal,
      },
    )
    const body = await readBoundedResponseBody(response)

    if (!response.ok) {
      throw new ModelCatalogError(
        `Provider model catalog request failed with status ${response.status}`,
        response.status,
      )
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(body)
    } catch {
      throw new ModelCatalogError('Provider returned an invalid model catalog')
    }

    if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
      throw new ModelCatalogError('Provider returned an invalid model catalog')
    }

    const data = Reflect.get(parsed, 'data')

    if (!Array.isArray(data) || data.length > MAX_MODELS) {
      throw new ModelCatalogError('Provider returned an invalid model catalog')
    }

    const models = new Map<string, ProviderModel>()

    for (const candidate of data) {
      if (!candidate || typeof candidate !== 'object') {
        continue
      }

      const id = Reflect.get(candidate, 'id')
      const ownedBy = Reflect.get(candidate, 'owned_by')

      if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        continue
      }

      models.set(id, {
        id,
        ...(typeof ownedBy === 'string' && ownedBy.length <= 256
          ? { ownedBy }
          : {}),
      })
    }

    return [...models.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_CATALOG_BYTES) {
      throw new ModelCatalogError('Provider model catalog is too large')
    }
    return new TextDecoder().decode(bytes)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ModelCatalogError('Provider model catalog is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export const fetchDeepSeekModelCatalog = fetchOpenAICompatibleModelCatalog

/** Fetches Anthropic's paginated model list with provider-native authentication. */
export async function fetchAnthropicModelCatalog(options: {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ProviderModel[]> {
  const controller = new AbortController()
  const relayAbort = () => controller.abort(options.signal?.reason)
  const timer = setTimeout(
    () => controller.abort(new Error('Model catalog request timed out')),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  options.signal?.addEventListener('abort', relayAbort, { once: true })
  const models = new Map<string, ProviderModel>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let totalBytes = 0

  try {
    for (let page = 0; page < 100; page += 1) {
      const endpoint = new URL(modelCatalogEndpoint(options.baseURL))
      endpoint.searchParams.set('limit', String(MAX_MODELS))
      if (cursor) endpoint.searchParams.set('after_id', cursor)
      const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      })
      const body = await readBoundedResponseBody(response)
      totalBytes += Buffer.byteLength(body, 'utf8')
      if (totalBytes > MAX_CATALOG_BYTES) {
        throw new ModelCatalogError('Provider model catalog is too large')
      }
      if (!response.ok) {
        throw new ModelCatalogError(
          `Provider model catalog request failed with status ${response.status}`,
          response.status,
        )
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        throw new ModelCatalogError(
          'Provider returned an invalid model catalog',
        )
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ModelCatalogError(
          'Provider returned an invalid model catalog',
        )
      }
      const data = Reflect.get(parsed, 'data')
      if (!Array.isArray(data) || data.length > MAX_MODELS) {
        throw new ModelCatalogError(
          'Provider returned an invalid model catalog',
        )
      }
      for (const candidate of data) {
        if (!candidate || typeof candidate !== 'object') continue
        const id = Reflect.get(candidate, 'id')
        if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
          continue
        }
        models.set(id, { id })
        if (models.size > MAX_MODELS) {
          throw new ModelCatalogError(
            'Provider returned an invalid model catalog',
          )
        }
      }
      if (Reflect.get(parsed, 'has_more') !== true) {
        return [...models.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        )
      }
      const next = Reflect.get(parsed, 'last_id')
      if (
        typeof next !== 'string' ||
        next.length === 0 ||
        next.length > 256 ||
        cursors.has(next)
      ) {
        throw new ModelCatalogError(
          'Provider returned an invalid model catalog cursor',
        )
      }
      cursors.add(next)
      cursor = next
    }
    throw new ModelCatalogError('Provider model catalog has too many pages')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

/** Fetches the model catalog appropriate for one configured Provider Type. */
export function fetchProviderModelCatalog(options: {
  providerType: ProviderType
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ProviderModel[]> {
  switch (options.providerType) {
    case 'deepseek.chat-completions':
    case 'generic.chat-completions':
    case 'generic.responses':
      return fetchOpenAICompatibleModelCatalog(options)
    case 'generic.anthropic':
      return fetchAnthropicModelCatalog(options)
  }
}

/** Builds model profiles for a provider and includes the selected model when absent from its catalog. */
export function resolveModelProfiles(
  config: PublicConfig,
  providerId = config.activeProviderId,
  includeModelId?: string,
): ModelProfile[] {
  const provider =
    getProviderConfig(config, providerId) ?? getActiveProviderConfig(config)
  const models = new Map(
    provider.modelCatalog.map((model) => [model.id, model]),
  )

  if (!models.has(provider.model)) {
    models.set(provider.model, { id: provider.model })
  }
  if (includeModelId && !models.has(includeModelId)) {
    models.set(includeModelId, { id: includeModelId })
  }

  return [...models.values()]
    .map((model): ModelProfile => {
      const override = provider.modelOverrides[model.id]
      const builtin = BUILTIN_MODEL_CAPABILITIES[model.id]
      const capabilitySource = override
        ? 'override'
        : builtin
          ? 'builtin'
          : 'default'

      return {
        ...model,
        availability: provider.modelCatalog.some(
          (candidate) => candidate.id === model.id,
        )
          ? 'provider'
          : 'custom',
        capabilitySource,
        contextWindowTokens:
          override?.contextWindowTokens ??
          builtin?.contextWindowTokens ??
          config.limits.maxContextTokens,
        maxOutputTokens: override?.maxOutputTokens ?? builtin?.maxOutputTokens,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}
