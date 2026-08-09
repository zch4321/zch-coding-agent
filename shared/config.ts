import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema } from './json'
import type { AssistantLanguage } from './system-prompts'
import { McpServerConfigSchema } from './mcp'
import {
  ModelPoolConfigSchema,
  ModelPoolProviderRevisionSchema,
} from './model-pool'
import { ReasoningEffortSchema, type ReasoningEffort } from './reasoning'

export {
  MAX_MODEL_POOL_ENTRIES,
  ModelPoolConfigSchema,
  ModelPoolEntrySchema,
  ModelPoolProviderRevisionSchema,
  normalizeModelPoolConfig,
  type ModelPoolConfig,
  type ModelPoolEntry,
  type ModelPoolProviderRevision,
} from './model-pool'
export {
  REASONING_EFFORTS,
  ReasoningEffortSchema,
  type ReasoningEffort,
} from './reasoning'

export const APP_CONFIG_SCHEMA_VERSION = 19 as const

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

export const DeepSeekReasoningEffortSchema = ReasoningEffortSchema
export type DeepSeekReasoningEffort = ReasoningEffort

export const ModelCapabilityLevelSchema = Type.Union([
  Type.Literal('light'),
  Type.Literal('standard'),
  Type.Literal('strong'),
])
export type ModelCapabilityLevel = Static<typeof ModelCapabilityLevelSchema>

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

export const ProviderModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    ownedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    contextWindowTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
  },
  { additionalProperties: false },
)
export type ProviderModel = Static<typeof ProviderModelSchema>

export const ModelCapabilityOverrideSchema = Type.Object(
  {
    contextWindowTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    compactThresholdTokens: Type.Optional(
      Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    ),
    reasoningEfforts: Type.Optional(
      Type.Array(ReasoningEffortSchema, { minItems: 1, uniqueItems: true }),
    ),
    capability: Type.Optional(ModelCapabilityLevelSchema),
  },
  { additionalProperties: false },
)
export type ModelCapabilityOverride = Static<
  typeof ModelCapabilityOverrideSchema
>

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

export const HttpProxyConfigSchema = Type.Union([
  Type.Object({ mode: Type.Literal('off') }, { additionalProperties: false }),
  Type.Object(
    { mode: Type.Literal('system') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal('manual'),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
])
export type HttpProxyConfig = Static<typeof HttpProxyConfigSchema>

export const PromptResourceRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
)

export const ProviderTypeSchema = Type.Union([
  Type.Literal('deepseek.chat-completions'),
  Type.Literal('generic.chat-completions'),
  Type.Literal('generic.responses'),
  Type.Literal('generic.anthropic'),
])
export type ProviderType = Static<typeof ProviderTypeSchema>

export const ProviderPublicConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    providerType: ProviderTypeSchema,
    revision: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
    model: Type.String({ maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    modelCatalog: Type.Array(ProviderModelSchema, { maxItems: 1_000 }),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides: Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      ModelCapabilityOverrideSchema,
      { maxProperties: 1_000 },
    ),
    enabledModelIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 1_000,
      uniqueItems: true,
    }),
    credentialConfigured: Type.Boolean(),
    credentialSource: Type.Union([
      Type.Literal('none'),
      Type.Literal('safe-storage'),
      Type.Literal('environment'),
    ]),
  },
  { additionalProperties: false },
)
export type ProviderPublicConfig = Static<typeof ProviderPublicConfigSchema>

export const PublicConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(APP_CONFIG_SCHEMA_VERSION),
    activeProviderId: Type.String({ minLength: 1, maxLength: 128 }),
    providers: Type.Array(ProviderPublicConfigSchema, {
      minItems: 1,
      maxItems: 32,
    }),
    approval: Type.Object(
      {
        approverProviderId: Type.String({ minLength: 1, maxLength: 128 }),
        approverModel: Type.String({ maxLength: 256 }),
        reasoning: ReasoningEffortSchema,
      },
      { additionalProperties: false },
    ),
    subagents: Type.Object(
      {
        enabled: Type.Boolean(),
        workerTimeoutMs: Type.Integer({
          minimum: 60_000,
          maximum: 86_400_000,
        }),
        maxAgentsPerSwarm: Type.Integer({ minimum: 1, maximum: 32 }),
      },
      { additionalProperties: false },
    ),
    modelPool: ModelPoolConfigSchema,
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
        maxConcurrentRuns: Type.Integer({ minimum: 1, maximum: 32 }),
        // Zero disables the React-loop step limit. Positive values remain
        // available for bounded autonomous deployment profiles.
        maxStepsPerRun: Type.Integer({ minimum: 0, maximum: 1_000 }),
        maxToolOutputBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
        maxAttachmentContextTokens: Type.Integer({
          minimum: 1_024,
          maximum: 1_000_000,
        }),
        autoCompactTriggerPercent: Type.Integer({ minimum: 50, maximum: 95 }),
        maxToolResultTokens: Type.Integer({
          minimum: 256,
          maximum: 1_000_000,
        }),
        tokenEstimation: TokenEstimationSchema,
        commandTimeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
        readFileSourceBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        readFileOutputBytes: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000,
        }),
        editableFileBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        writeFileBytes: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000,
        }),
        patchBytes: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000,
        }),
        diffChars: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000,
        }),
        fileChangeHistoryBytes: Type.Integer({
          minimum: 1_000_000,
          maximum: 10_000_000_000,
        }),
        approvalTimeoutMs: Type.Integer({
          minimum: 1_000,
          maximum: 86_400_000,
        }),
        autoApprovalTimeoutMs: Type.Integer({
          minimum: 1_000,
          maximum: 300_000,
        }),
        modelCatalogTimeoutMs: Type.Integer({
          minimum: 1_000,
          maximum: 300_000,
        }),
        terminalScrollbackBytes: Type.Integer({
          minimum: 1_024,
          maximum: 100_000_000,
        }),
        fetchResponseBytes: Type.Integer({
          minimum: 1_024,
          maximum: 10_000_000,
        }),
        fetchTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 60_000 }),
        fetchMaxRedirects: Type.Integer({ minimum: 0, maximum: 10 }),
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
        preferences: Type.Object(
          {
            'zh-CN': Type.String({ maxLength: 32_768 }),
            'en-US': Type.String({ maxLength: 32_768 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    prompts: Type.Object(
      {
        approval: Type.Object(
          {
            classifyRisk: PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        orchestration: Type.Object(
          {
            goalStarted: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
            goalContinue: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
            planStarted: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
            planContinue: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
            planWarning: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
            compact: Type.Object(
              {
                'zh-CN': PromptResourceRefSchema,
                'en-US': PromptResourceRefSchema,
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    network: Type.Object(
      {
        httpProxy: HttpProxyConfigSchema,
      },
      { additionalProperties: false },
    ),
    webSearch: Type.Object(
      {
        provider: Type.Union([Type.Literal('brave')]),
        credentialConfigured: Type.Boolean(),
        credentialSource: Type.Union([
          Type.Literal('safe-storage'),
          Type.Literal('environment'),
          Type.Literal('none'),
        ]),
        count: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    mcpServers: Type.Array(McpServerConfigSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
)
export type PublicConfig = Static<typeof PublicConfigSchema>

/** Finds the configured provider with the given ID. */
export function getProviderConfig(
  config: PublicConfig,
  providerId: string,
): ProviderPublicConfig | undefined {
  return config.providers.find((provider) => provider.id === providerId)
}

/** Selects the active provider, falling back to the first configured provider when necessary. */
export function getActiveProviderConfig(
  config: PublicConfig,
): ProviderPublicConfig {
  return (
    getProviderConfig(config, config.activeProviderId) ?? config.providers[0]
  )
}

export const ConfigSectionSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('providers'),
  Type.Literal('approval'),
  Type.Literal('subagents'),
  Type.Literal('modelPool'),
  Type.Literal('permission'),
  Type.Literal('limits'),
  Type.Literal('logging'),
  Type.Literal('privacy'),
  Type.Literal('workspace'),
  Type.Literal('skills'),
  Type.Literal('assistant'),
  Type.Literal('prompts'),
  Type.Literal('network'),
  Type.Literal('webSearch'),
  Type.Literal('mcp'),
])
export type ConfigSection = Static<typeof ConfigSectionSchema>

export const ConfigSetRequestSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('model-pool'),
      value: ModelPoolConfigSchema,
      expectedProviderRevisions: Type.Array(ModelPoolProviderRevisionSchema, {
        maxItems: 32,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      providerType: Type.Optional(ProviderTypeSchema),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ maxLength: 256 }),
      enabledModelIds: Type.Optional(
        ProviderPublicConfigSchema.properties.enabledModelIds,
      ),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      compactThresholdTokens: Type.Optional(
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
      modelOverrides: Type.Optional(
        Type.Record(
          Type.String({ minLength: 1, maxLength: 256 }),
          ModelCapabilityOverrideSchema,
          { maxProperties: 1_000 },
        ),
      ),
      reasoning: ReasoningEffortSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-settings'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      providerType: Type.Optional(ProviderTypeSchema),
      baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
      model: Type.String({ maxLength: 256 }),
      enabledModelIds: Type.Optional(
        ProviderPublicConfigSchema.properties.enabledModelIds,
      ),
      contextWindowTokens: Type.Optional(
        Type.Union([
          Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
          Type.Null(),
        ]),
      ),
      compactThresholdTokens: Type.Optional(
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
      modelOverrides: Type.Optional(
        Type.Record(
          Type.String({ minLength: 1, maxLength: 256 }),
          ModelCapabilityOverrideSchema,
          { maxProperties: 1_000 },
        ),
      ),
      reasoning: ReasoningEffortSchema,
      limits: PublicConfigSchema.properties.limits,
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-model-add'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
      modelOverride: Type.Optional(ModelCapabilityOverrideSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-model-delete'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-select'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-copy'),
      sourceProviderId: Type.String({ minLength: 1, maxLength: 128 }),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      label: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('provider-delete'),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      fallbackProviderId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128 }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      action: Type.Literal('set'),
      apiKey: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('credential'),
      providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      action: Type.Literal('clear'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('approval'),
      approverProviderId: Type.String({ minLength: 1, maxLength: 128 }),
      approverModel: Type.String({ maxLength: 256 }),
      reasoning: ReasoningEffortSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('subagents'),
      value: PublicConfigSchema.properties.subagents,
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
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('prompts'),
      value: PublicConfigSchema.properties.prompts,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('network'),
      value: PublicConfigSchema.properties.network,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('web-search'),
      provider: Type.Union([Type.Literal('brave')]),
      count: Type.Integer({ minimum: 1, maximum: 20 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('web-search-credential'),
      action: Type.Union([Type.Literal('set'), Type.Literal('clear')]),
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    },
    { additionalProperties: false },
  ),
])
export type ConfigSetRequest = Static<typeof ConfigSetRequestSchema>
