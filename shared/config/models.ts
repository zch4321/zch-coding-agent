import { Type, type Static } from '@sinclair/typebox'
import { ModelPoolConfigSchema } from '../model-pool'
import { ReasoningEffortSchema } from '../reasoning'
import { ProviderPublicConfigSchema } from './providers'

export const ModelRolesConfigSchema = Type.Object(
  {
    defaultModelProvider: Type.String({ minLength: 1, maxLength: 128 }),
    defaultModel: Type.String({ maxLength: 256 }),
    defaultModelReasoning: ReasoningEffortSchema,
    auxiliaryModelProvider: Type.String({ maxLength: 128 }),
    auxiliaryModel: Type.String({ maxLength: 256 }),
    auxiliaryModelReasoning: ReasoningEffortSchema,
  },
  { additionalProperties: false },
)
export type ModelRolesConfig = Static<typeof ModelRolesConfigSchema>

export const ModelsConfigSchema = Type.Object(
  {
    ...ModelRolesConfigSchema.properties,
    providers: Type.Array(ProviderPublicConfigSchema, {
      minItems: 1,
      maxItems: 32,
    }),
    modelPool: ModelPoolConfigSchema,
  },
  { additionalProperties: false },
)
export type ModelsConfig = Static<typeof ModelsConfigSchema>
