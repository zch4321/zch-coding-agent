import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema } from '../json'

export const PermissionModeSchema = Type.Union([
  Type.Literal('readonly'),
  Type.Literal('auto'),
  Type.Literal('confirm'),
  Type.Literal('yolo'),
])
export type PermissionMode = Static<typeof PermissionModeSchema>

export const RememberedRuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    effect: Type.Union([Type.Literal('allow'), Type.Literal('review')]),
    toolId: Type.String({ minLength: 1, maxLength: 512 }),
    workspaceScope: Type.String({ minLength: 1, maxLength: 4096 }),
    argConstraints: JsonValueSchema,
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
    createdFromCallId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)
export type RememberedRule = Static<typeof RememberedRuleSchema>

export const PermissionConfigSchema = Type.Object(
  {
    defaultMode: PermissionModeSchema,
    builtinPolicies: Type.Boolean(),
    rememberedRules: Type.Array(RememberedRuleSchema, { maxItems: 256 }),
    sensitiveData: Type.Object(
      {
        mode: Type.Union([
          Type.Literal('off'),
          Type.Literal('warn'),
          Type.Literal('confirm'),
        ]),
        pathGlobs: Type.Array(Type.String({ maxLength: 1024 }), {
          maxItems: 256,
        }),
        contentPatterns: Type.Array(Type.String({ maxLength: 2048 }), {
          maxItems: 256,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type PermissionConfig = Static<typeof PermissionConfigSchema>

export const PrivacyConfigSchema = Type.Object(
  {
    providerNoticeAccepted: Type.Optional(
      Type.Object(
        {
          version: Type.String({ minLength: 1, maxLength: 64 }),
          acceptedAt: Type.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
    ),
    traceNoticeAccepted: Type.Optional(
      Type.Object(
        {
          version: Type.String({ minLength: 1, maxLength: 64 }),
          acceptedAt: Type.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
    ),
    yoloNoticeAccepted: Type.Optional(
      Type.Object(
        {
          version: Type.String({ minLength: 1, maxLength: 64 }),
          acceptedAt: Type.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type PrivacyConfig = Static<typeof PrivacyConfigSchema>
