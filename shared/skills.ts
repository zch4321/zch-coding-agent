import { Type, type Static } from '@sinclair/typebox'

export const SkillSourceSchema = Type.Union([
  Type.Literal('manual'),
  Type.Literal('download'),
  Type.Literal('upload'),
])
export type SkillSource = Static<typeof SkillSourceSchema>

export const SkillSummarySchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
    }),
    description: Type.String({ minLength: 1, maxLength: 2_048 }),
    trigger: Type.Optional(Type.String({ maxLength: 2_048 })),
    enabled: Type.Boolean(),
    source: SkillSourceSchema,
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    trustedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
)
export type SkillSummary = Static<typeof SkillSummarySchema>

export const SkillDiagnosticSchema = Type.Object(
  {
    file: Type.String({ maxLength: 512 }),
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ minLength: 1, maxLength: 1_024 }),
  },
  { additionalProperties: false },
)
export type SkillDiagnostic = Static<typeof SkillDiagnosticSchema>

export const SkillListSchema = Type.Object(
  {
    skills: Type.Array(SkillSummarySchema, { maxItems: 128 }),
    diagnostics: Type.Array(SkillDiagnosticSchema, { maxItems: 256 }),
  },
  { additionalProperties: false },
)
export type SkillList = Static<typeof SkillListSchema>
