import { Type, type Static } from '@sinclair/typebox'

export const ReasoningEffortSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
])
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>

/** All reasoning efforts in ascending strength order. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]
