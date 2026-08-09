import { Type, type Static } from '@sinclair/typebox'

export const CommandShellProfileIdSchema = Type.Union([
  Type.Literal('powershell-7'),
  Type.Literal('windows-powershell'),
  Type.Literal('cmd'),
  Type.Literal('git-bash'),
  Type.Literal('nushell'),
  Type.Literal('system-shell'),
])
export type CommandShellProfileId = Static<typeof CommandShellProfileIdSchema>

export const CommandShellSelectionSchema = Type.Union([
  Type.Literal('auto'),
  CommandShellProfileIdSchema,
])
export type CommandShellSelection = Static<typeof CommandShellSelectionSchema>

export const CommandShellKindSchema = Type.Union([
  Type.Literal('powershell'),
  Type.Literal('cmd'),
  Type.Literal('bash'),
  Type.Literal('nushell'),
  Type.Literal('posix'),
])
export type CommandShellKind = Static<typeof CommandShellKindSchema>

export const CommandShellProfileSchema = Type.Object(
  {
    id: CommandShellProfileIdSchema,
    kind: CommandShellKindSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    executable: Type.String({ minLength: 1, maxLength: 4_096 }),
    source: Type.Union([
      Type.Literal('path'),
      Type.Literal('well-known'),
      Type.Literal('system'),
    ]),
  },
  { additionalProperties: false },
)
export type CommandShellProfile = Static<typeof CommandShellProfileSchema>

export const CommandShellCatalogSchema = Type.Object(
  {
    selected: CommandShellSelectionSchema,
    resolved: CommandShellProfileSchema,
    fallback: Type.Boolean(),
    profiles: Type.Array(CommandShellProfileSchema, {
      minItems: 1,
      maxItems: 16,
    }),
  },
  { additionalProperties: false },
)
export type CommandShellCatalog = Static<typeof CommandShellCatalogSchema>
