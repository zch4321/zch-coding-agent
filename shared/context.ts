import { Type, type Static } from '@sinclair/typebox'

export const ContextAttachmentKindSchema = Type.Union([
  Type.Literal('file'),
  Type.Literal('directory'),
])
export type ContextAttachmentKind = Static<typeof ContextAttachmentKindSchema>

export const ContextAttachmentSourceSchema = Type.Union([
  Type.Literal('mention'),
  Type.Literal('picker'),
])
export type ContextAttachmentSource = Static<
  typeof ContextAttachmentSourceSchema
>

export const ContextAttachmentRefSchema = Type.Object(
  {
    kind: ContextAttachmentKindSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    source: Type.Optional(ContextAttachmentSourceSchema),
  },
  { additionalProperties: false },
)
export type ContextAttachmentRef = Static<typeof ContextAttachmentRefSchema>

export const ContextAttachmentChipSchema = Type.Object(
  {
    kind: ContextAttachmentKindSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    source: ContextAttachmentSourceSchema,
    totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export type ContextAttachmentChip = Static<typeof ContextAttachmentChipSchema>

export const RunContextSchema = Type.Object(
  {
    attachments: Type.Array(ContextAttachmentRefSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
)
export type RunContext = Static<typeof RunContextSchema>
