import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema } from './json'
import type { AssistantLanguage } from './system-prompts'

export const AssistantLanguageSchema = Type.Union([
  Type.Literal('zh-CN'),
  Type.Literal('en-US'),
])
export type { AssistantLanguage }

export const PermissionModeSchema = Type.Union([
  Type.Literal('readonly'),
  Type.Literal('auto'),
  Type.Literal('confirm'),
  Type.Literal('yolo'),
])
export type PermissionMode = Static<typeof PermissionModeSchema>

export const DeepSeekReasoningEffortSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('high'),
  Type.Literal('max'),
])
export type DeepSeekReasoningEffort = Static<
  typeof DeepSeekReasoningEffortSchema
>

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

export const ProviderModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    ownedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
)
export type ProviderModel = Static<typeof ProviderModelSchema>

export const ModelCapabilityOverrideSchema = Type.Object(
  {
    contextWindowTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
  },
  { additionalProperties: false },
)

export const TokenEstimationSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal('conservative'),
      Type.Literal('custom-bytes'),
    ]),
    bytesPerToken: Type.Number({ minimum: 0.25, maximum: 32 }),
  },
  { additionalProperties: false },
)

export const DeepSeekPublicConfigSchema = Type.Object(
  {
    baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: DeepSeekReasoningEffortSchema,
    modelCatalog: Type.Array(ProviderModelSchema, { maxItems: 1_000 }),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides: Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      ModelCapabilityOverrideSchema,
      { maxProperties: 256 },
    ),
    credentialConfigured: Type.Boolean(),
    credentialSource: Type.Union([
      Type.Literal('none'),
      Type.Literal('safe-storage'),
      Type.Literal('environment'),
    ]),
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
    ),
    limits: Type.Object(
      {
        maxStepsPerRun: Type.Integer({ minimum: 1, maximum: 1_000 }),
        maxToolOutputBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
        maxToolResultTokens: Type.Integer({
          minimum: 256,
          maximum: 1_000_000,
        }),
        maxToolTokensPerRun: Type.Integer({
          minimum: 256,
          maximum: 10_000_000,
        }),
        tokenEstimation: TokenEstimationSchema,
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
    privacy: Type.Object(
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
    assistant: Type.Object(
      {
        language: AssistantLanguageSchema,
        systemPrompts: Type.Object(
          {
            'zh-CN': Type.String({ minLength: 1, maxLength: 32_768 }),
            'en-US': Type.String({ minLength: 1, maxLength: 32_768 }),
          },
          { additionalProperties: false },
        ),
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
  Type.Literal('privacy'),
  Type.Literal('workspace'),
  Type.Literal('skills'),
  Type.Literal('assistant'),
])
export type ConfigSection = Static<typeof ConfigSectionSchema>

export const ConfigSetRequestSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider'),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ minLength: 1, maxLength: 256 }),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      maxOutputTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      reasoning: DeepSeekReasoningEffortSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-settings'),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ minLength: 1, maxLength: 256 }),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      maxOutputTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      reasoning: DeepSeekReasoningEffortSchema,
      approverProvider: Type.String({ minLength: 1, maxLength: 128 }),
      approverModel: Type.String({ minLength: 1, maxLength: 256 }),
      limits: PublicConfigSchema.properties.limits,
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
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
      kind: Type.Literal('privacy'),
      providerNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.providerNoticeAccepted,
      ),
      traceNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.traceNoticeAccepted,
      ),
      yoloNoticeAccepted: Type.Optional(
        PublicConfigSchema.properties.privacy.properties.yoloNoticeAccepted,
      ),
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
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('assistant'),
      value: PublicConfigSchema.properties.assistant,
    },
    { additionalProperties: false },
  ),
])
export type ConfigSetRequest = Static<typeof ConfigSetRequestSchema>
