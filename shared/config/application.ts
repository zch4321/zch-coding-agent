import { Type, type Static } from '@sinclair/typebox'

export const OperationalLogLevelSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('error'),
  Type.Literal('warn'),
  Type.Literal('info'),
  Type.Literal('debug'),
])
export type OperationalLogLevel = Static<typeof OperationalLogLevelSchema>

export const LogRetentionConfigSchema = Type.Object(
  {
    retentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
    maxTotalBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000_000,
    }),
  },
  { additionalProperties: false },
)
export type LogRetentionConfig = Static<typeof LogRetentionConfigSchema>

export const LoggingConfigSchema = Type.Object(
  {
    operational: Type.Object(
      {
        level: OperationalLogLevelSchema,
        ...LogRetentionConfigSchema.properties,
      },
      { additionalProperties: false },
    ),
    trace: Type.Object(
      {
        enabled: Type.Boolean(),
        ...LogRetentionConfigSchema.properties,
      },
      { additionalProperties: false },
    ),
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
