import { Type, type Static } from '@sinclair/typebox'

export const GoalStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('blocked'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
])
export type GoalStatus = Static<typeof GoalStatusSchema>

export const GoalStateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    objective: Type.String({ minLength: 1, maxLength: 16_384 }),
    status: GoalStatusSchema,
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    continuationCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
    summary: Type.Optional(Type.String({ maxLength: 65_536 })),
    evidence: Type.Optional(Type.String({ maxLength: 65_536 })),
    remainingRisks: Type.Optional(Type.String({ maxLength: 65_536 })),
    blockReason: Type.Optional(Type.String({ maxLength: 65_536 })),
    requiredInput: Type.Optional(Type.String({ maxLength: 65_536 })),
  },
  { additionalProperties: false },
)
export type GoalState = Static<typeof GoalStateSchema>

export const PlanItemStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('blocked'),
  Type.Literal('cancelled'),
])
export type PlanItemStatus = Static<typeof PlanItemStatusSchema>

export const PlanStatusSchema = Type.Union([
  Type.Literal('awaiting_review'),
  Type.Literal('active'),
  Type.Literal('rejected'),
  Type.Literal('completed'),
])
export type PlanStatus = Static<typeof PlanStatusSchema>

export const PlanItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 4_096 }),
    status: PlanItemStatusSchema,
    updatedAt: Type.String({ format: 'date-time' }),
    result: Type.Optional(Type.String({ maxLength: 65_536 })),
    evidence: Type.Optional(Type.String({ maxLength: 65_536 })),
  },
  { additionalProperties: false },
)
export type PlanItem = Static<typeof PlanItemSchema>

export const PlanStateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    objective: Type.String({ minLength: 1, maxLength: 16_384 }),
    status: Type.Optional(PlanStatusSchema),
    items: Type.Array(PlanItemSchema, { maxItems: 256 }),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    continuationCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
    warning: Type.Optional(Type.String({ maxLength: 65_536 })),
  },
  { additionalProperties: false },
)
export type PlanState = Static<typeof PlanStateSchema>
