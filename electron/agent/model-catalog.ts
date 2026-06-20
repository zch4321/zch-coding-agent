import type { PublicConfig, ProviderModel } from '../../shared/config'

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

export class ModelCatalogError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ModelCatalogError'
    this.status = status
  }
}

export function modelCatalogEndpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('models', normalized).toString()
}

export async function fetchDeepSeekModelCatalog(options: {
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
    const body = await response.text()

    if (Buffer.byteLength(body, 'utf8') > MAX_CATALOG_BYTES) {
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

export function resolveModelProfiles(config: PublicConfig): ModelProfile[] {
  const provider = config.providers.deepseek
  const models = new Map(
    provider.modelCatalog.map((model) => [model.id, model]),
  )

  if (!models.has(provider.model)) {
    models.set(provider.model, { id: provider.model })
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
