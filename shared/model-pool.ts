import { Type, type Static } from '@sinclair/typebox'
import { ReasoningEffortSchema } from './reasoning'

export const ModelPoolCapabilitySchema = Type.Union([
  Type.Literal('light'),
  Type.Literal('standard'),
  Type.Literal('strong'),
])
export type ModelPoolCapability = Static<typeof ModelPoolCapabilitySchema>

export const ModelPoolEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    enabled: Type.Boolean(),
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    capability: ModelPoolCapabilitySchema,
    maxParallel: Type.Integer({ minimum: 1, maximum: 32 }),
  },
  { additionalProperties: false },
)
export type ModelPoolEntry = Static<typeof ModelPoolEntrySchema>

export const ModelPoolConfigSchema = Type.Object(
  {
    entries: Type.Array(ModelPoolEntrySchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
)
export type ModelPoolConfig = Static<typeof ModelPoolConfigSchema>

export const ModelPoolProviderRevisionSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)
export type ModelPoolProviderRevision = Static<
  typeof ModelPoolProviderRevisionSchema
>

const DISALLOWED_ID_CHARACTER = /[\p{Cc}\p{Cf}]/u

/** Normalizes every entry ID and rejects unsafe or colliding model-pool identities. */
export function normalizeModelPoolConfig(
  config: ModelPoolConfig,
): ModelPoolConfig {
  const ids = new Set<string>()
  const entries = config.entries.map((entry) => {
    const id = entry.id.trim().normalize('NFC')
    const length = [...id].length

    if (length < 1 || length > 64) {
      throw new Error('Model pool entry id must contain 1 to 64 characters')
    }
    if (DISALLOWED_ID_CHARACTER.test(id)) {
      throw new Error(
        `Model pool entry id contains a control or format character: ${JSON.stringify(id)}`,
      )
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate model pool entry id: ${id}`)
    }
    ids.add(id)

    return {
      ...structuredClone(entry),
      id,
    }
  })

  return { entries }
}
