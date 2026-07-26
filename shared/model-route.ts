import { Type, type Static } from '@sinclair/typebox'
import { ReasoningEffortSchema } from './config'
import { DurableSchemaVersionSchema, RevisionSchema } from './durable'

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

export const ModelRouteSnapshotSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    purpose: ProviderPurposeSchema,
    adapterId: Type.String({ minLength: 1, maxLength: 128 }),
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
