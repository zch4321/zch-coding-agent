import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema } from './json'

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
    toolId: Type.String({ minLength: 1, maxLength: 128 }),
    workspaceScope: Type.String({ minLength: 1, maxLength: 4096 }),
    argConstraints: JsonValueSchema,
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
    createdFromCallId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)
export type RememberedRule = Static<typeof RememberedRuleSchema>

export const DeepSeekPublicConfigSchema = Type.Object(
  {
    baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: Type.Union([Type.Literal('auto'), Type.Literal('off')]),
    credentialConfigured: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const PublicConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    activeProvider: Type.Literal('deepseek'),
    providers: Type.Object(
      {
        deepseek: DeepSeekPublicConfigSchema,
      },
      { additionalProperties: false },
    ),
    approval: Type.Object(
      {
        approverProvider: Type.String({ minLength: 1, maxLength: 128 }),
        approverModel: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
    permission: Type.Object(
      {
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
    ),
    limits: Type.Object(
      {
        maxStepsPerRun: Type.Integer({ minimum: 1, maximum: 1_000 }),
        maxToolOutputBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
        commandTimeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
        terminalScrollbackBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
      },
      { additionalProperties: false },
    ),
    logging: Type.Object(
      {
        enabled: Type.Boolean(),
        retentionDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
        maxTotalBytes: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000_000,
        }),
      },
      { additionalProperties: false },
    ),
    workspace: Type.Object(
      {
        lastOpened: Type.Optional(
          Type.String({ minLength: 1, maxLength: 4096 }),
        ),
      },
      { additionalProperties: false },
    ),
    skills: Type.Object(
      {
        enabled: Type.Boolean(),
        maxSummaryChars: Type.Integer({ minimum: 128, maximum: 100_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type PublicConfig = Static<typeof PublicConfigSchema>

export const ConfigSectionSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('providers'),
  Type.Literal('approval'),
  Type.Literal('permission'),
  Type.Literal('limits'),
  Type.Literal('logging'),
  Type.Literal('workspace'),
  Type.Literal('skills'),
])
export type ConfigSection = Static<typeof ConfigSectionSchema>

export const ConfigSetRequestSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider'),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ minLength: 1, maxLength: 256 }),
      reasoning: Type.Union([Type.Literal('auto'), Type.Literal('off')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      action: Type.Literal('set'),
      apiKey: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      action: Type.Literal('clear'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('approval'),
      approverProvider: Type.String({ minLength: 1, maxLength: 128 }),
      approverModel: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('permission'),
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
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('limits'),
      value: PublicConfigSchema.properties.limits,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('logging'),
      value: PublicConfigSchema.properties.logging,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('workspace'),
      lastOpened: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('skills'),
      value: PublicConfigSchema.properties.skills,
    },
    { additionalProperties: false },
  ),
])
export type ConfigSetRequest = Static<typeof ConfigSetRequestSchema>
