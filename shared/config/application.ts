import { Type, type Static } from '@sinclair/typebox'

export const LoggingConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    retentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
    maxTotalBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000_000,
    }),
  },
  { additionalProperties: false },
)
export type LoggingConfig = Static<typeof LoggingConfigSchema>

export const WorkspaceConfigSchema = Type.Object(
  {
    lastOpened: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
)
export type WorkspaceConfig = Static<typeof WorkspaceConfigSchema>
