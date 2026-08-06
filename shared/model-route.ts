import { Type, type Static } from '@sinclair/typebox'
import { RevisionSchema } from './durable'
import { resolveSupportedReasoningEfforts } from './model-settings'
import { ReasoningEffortSchema, type ReasoningEffort } from './reasoning'

export const MODEL_ROUTE_SCHEMA_VERSION = 2 as const

export const ProviderPurposeSchema = Type.Union([
  Type.Literal('main'),
  Type.Literal('approval'),
  Type.Literal('compression'),
])
export type ProviderPurpose = Static<typeof ProviderPurposeSchema>

export const ModelSelectionSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
  },
  { additionalProperties: false },
)
export type ModelSelection = Static<typeof ModelSelectionSchema>

export interface ModelRouteCompatibilityProvider {
  enabledModelIds: readonly string[]
  modelOverrides: Readonly<
    Record<string, { reasoningEfforts?: readonly ReasoningEffort[] }>
  >
}

export type ModelRouteCompatibility =
  | { ok: true }
  | { ok: false; reason: 'provider-missing' }
  | { ok: false; reason: 'model-empty' }
  | { ok: false; reason: 'model-disabled' }
  | {
      ok: false
      reason: 'reasoning-unsupported'
      supportedReasoningEfforts: ReasoningEffort[]
    }

/**
 * Evaluates process-neutral configuration compatibility for one model route.
 * Credentials, endpoints and live Provider availability remain runtime checks.
 */
export function evaluateModelRouteCompatibility(
  provider: ModelRouteCompatibilityProvider | undefined,
  selection: Pick<ModelSelection, 'model' | 'reasoning'>,
): ModelRouteCompatibility {
  if (!provider) return { ok: false, reason: 'provider-missing' }
  if (!selection.model) return { ok: false, reason: 'model-empty' }
  if (!provider.enabledModelIds.includes(selection.model)) {
    return { ok: false, reason: 'model-disabled' }
  }
  const supportedReasoningEfforts = resolveSupportedReasoningEfforts(
    provider.modelOverrides[selection.model],
  )
  if (!supportedReasoningEfforts.includes(selection.reasoning)) {
    return {
      ok: false,
      reason: 'reasoning-unsupported',
      supportedReasoningEfforts,
    }
  }
  return { ok: true }
}

export const ModelRouteSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MODEL_ROUTE_SCHEMA_VERSION),
    purpose: ProviderPurposeSchema,
    providerType: Type.String({ minLength: 1, maxLength: 128 }),
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    endpoint: Type.String({ minLength: 1, maxLength: 2_048 }),
    providerConfigRevision: RevisionSchema,
  },
  { additionalProperties: false },
)
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshotSchema>

const CREDENTIAL_QUERY_KEY =
  /(?:api[-_]?key|authorization|credential|password|secret|signature|token)/iu

/** Normalizes a provider base URL and appends the OpenAI-compatible chat completions path. */
export function resolveChatCompletionsEndpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('chat/completions', normalized).toString()
}

/** Normalizes a provider base URL and appends the Responses path. */
export function resolveResponsesEndpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('responses', normalized).toString()
}

/** Normalizes a provider base URL and appends the Anthropic Messages path. */
export function resolveAnthropicMessagesEndpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('messages', normalized).toString()
}

/** Rejects route snapshots with invalid endpoints or fields that could carry credentials. */
export function assertModelRouteSnapshotSafe(route: ModelRouteSnapshot): void {
  let endpoint: URL
  try {
    endpoint = new URL(route.endpoint)
  } catch {
    throw new TypeError('Model route endpoint must be an absolute URL')
  }

  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new TypeError('Model route endpoint must use HTTP or HTTPS')
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError(
      'Model route endpoint must not contain credentials or fragments',
    )
  }
  for (const key of endpoint.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      throw new TypeError(
        'Model route endpoint must not contain credential query parameters',
      )
    }
  }
}
