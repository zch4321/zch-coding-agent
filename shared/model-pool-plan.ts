import { Type, type Static } from '@sinclair/typebox'
import { ModelCapabilityLevelSchema } from './config'
import { ModelRouteSnapshotSchema } from './model-route'
import { ReasoningEffortSchema } from './reasoning'

export const MODEL_POOL_PLAN_SCHEMA_VERSION = 1 as const

export const ModelPoolPlanAssignmentSnapshotSchema = Type.Object(
  {
    requirementIndex: Type.Integer({ minimum: 0 }),
    requestedCapability: ModelCapabilityLevelSchema,
    entryId: Type.String({ minLength: 1, maxLength: 64 }),
    capability: ModelCapabilityLevelSchema,
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    providerRevision: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    maxParallel: Type.Integer({ minimum: 1, maximum: 32 }),
    routes: Type.Object(
      {
        main: ModelRouteSnapshotSchema,
        compression: ModelRouteSnapshotSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type ModelPoolPlanAssignmentSnapshot = Static<
  typeof ModelPoolPlanAssignmentSnapshotSchema
>

export const ModelPoolPlanSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MODEL_POOL_PLAN_SCHEMA_VERSION),
    poolDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    assignments: Type.Array(ModelPoolPlanAssignmentSnapshotSchema),
  },
  { additionalProperties: false },
)
export type ModelPoolPlanSnapshot = Static<typeof ModelPoolPlanSnapshotSchema>
