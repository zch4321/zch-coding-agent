import { Type, type Static } from '@sinclair/typebox'
import {
  APP_CONFIG_SCHEMA_VERSION,
  PermissionModeSchema,
  ProviderTypeSchema,
  PublicConfigSchema,
  ReasoningEffortSchema,
  RememberedRuleSchema,
  type ProviderPublicConfig,
  type PublicConfig,
} from '../../shared/config'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_ORCHESTRATION_PROMPT_REFS,
} from '../../shared/prompt-resources'
import { DEFAULT_ASSISTANT_PREFERENCES } from '../../shared/system-prompts'
import { McpServerConfigSchema } from '../../shared/mcp'
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from '../../shared/model-settings'

export const AppProviderConfigSchema = Type.Object(
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
    modelCatalog: Type.Array(
      PublicConfigSchema.properties.providers.items.properties.modelCatalog
        .items,
      { maxItems: 1_000 },
    ),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides:
      PublicConfigSchema.properties.providers.items.properties.modelOverrides,
    enabledModelIds:
      PublicConfigSchema.properties.providers.items.properties.enabledModelIds,
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)

export type AppProviderConfig = Static<typeof AppProviderConfigSchema>

export const AppWebSearchConfigSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal('brave')]),
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    count: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
)

export type AppWebSearchConfig = Static<typeof AppWebSearchConfigSchema>

export const AppConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(APP_CONFIG_SCHEMA_VERSION),
    activeProviderId: Type.String({ minLength: 1, maxLength: 128 }),
    providers: Type.Array(AppProviderConfigSchema, {
      minItems: 1,
      maxItems: 32,
    }),
    approval: PublicConfigSchema.properties.approval,
    subagents: PublicConfigSchema.properties.subagents,
    modelPool: PublicConfigSchema.properties.modelPool,
    permission: Type.Object(
      {
        defaultMode: PermissionModeSchema,
        builtinPolicies: Type.Boolean(),
        rememberedRules: Type.Array(RememberedRuleSchema, { maxItems: 256 }),
        sensitiveData:
          PublicConfigSchema.properties.permission.properties.sensitiveData,
      },
      { additionalProperties: false },
    ),
    limits: PublicConfigSchema.properties.limits,
    logging: PublicConfigSchema.properties.logging,
    privacy: PublicConfigSchema.properties.privacy,
    workspace: PublicConfigSchema.properties.workspace,
    skills: PublicConfigSchema.properties.skills,
    assistant: PublicConfigSchema.properties.assistant,
    prompts: PublicConfigSchema.properties.prompts,
    network: PublicConfigSchema.properties.network,
    webSearch: AppWebSearchConfigSchema,
    mcpServers: Type.Array(McpServerConfigSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
)

export type AppConfig = Static<typeof AppConfigSchema>

export const DEFAULT_PROVIDER_ID = 'deepseek'

export const DEFAULT_APP_CONFIG = {
  schemaVersion: APP_CONFIG_SCHEMA_VERSION,
  activeProviderId: DEFAULT_PROVIDER_ID,
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      label: 'DeepSeek',
      providerType: 'deepseek.chat-completions',
      revision: 1,
      baseURL: 'https://api.deepseek.com',
      model: '',
      modelCatalog: [],
      modelOverrides: {},
      enabledModelIds: [],
      reasoning: 'high',
    },
  ],
  approval: {
    approverProviderId: DEFAULT_PROVIDER_ID,
    approverModel: '',
    reasoning: 'high',
  },
  subagents: {
    enabled: false,
    workerTimeoutMs: 30 * 60_000,
    maxAgentsPerSwarm: 10,
  },
  modelPool: {
    entries: [],
  },
  permission: {
    defaultMode: 'readonly',
    builtinPolicies: true,
    rememberedRules: [],
    sensitiveData: {
      mode: 'off',
      pathGlobs: [],
      contentPatterns: [],
    },
  },
  limits: {
    maxConcurrentRuns: 16,
    maxStepsPerRun: 0,
    maxToolOutputBytes: 128 * 1_024,
    maxContextTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    maxAttachmentContextTokens: 64_000,
    autoCompactTriggerPercent: 80,
    maxToolResultTokens: 64_000,
    tokenEstimation: {
      mode: 'conservative',
      bytesPerToken: 3,
    },
    commandTimeoutMs: 120_000,
    readFileSourceBytes: 10_000_000,
    readFileOutputBytes: 128 * 1_024,
    editableFileBytes: 10_000_000,
    writeFileBytes: 256 * 1_024,
    patchBytes: 64 * 1_024,
    diffChars: 120_000,
    fileChangeHistoryBytes: 100_000_000,
    approvalTimeoutMs: 10 * 60_000,
    autoApprovalTimeoutMs: 60_000,
    modelCatalogTimeoutMs: 15_000,
    terminalScrollbackBytes: 2_000_000,
    fetchResponseBytes: 256 * 1_024,
    fetchTimeoutMs: 20_000,
    fetchMaxRedirects: 5,
  },
  logging: {
    enabled: false,
    retentionDays: 14,
    maxTotalBytes: 500_000_000,
  },
  privacy: {},
  workspace: {},
  skills: {
    enabled: true,
    maxSummaryChars: 2_000,
  },
  assistant: {
    language: 'zh-CN',
    preferences: structuredClone(DEFAULT_ASSISTANT_PREFERENCES),
  },
  prompts: {
    approval: structuredClone(DEFAULT_APPROVAL_PROMPT_REFS),
    orchestration: structuredClone(DEFAULT_ORCHESTRATION_PROMPT_REFS),
  },
  network: {
    httpProxy: { mode: 'off' },
  },
  webSearch: {
    provider: 'brave',
    count: 5,
  },
  mcpServers: [],
} satisfies AppConfig

/** Finds an application provider by its stable provider ID. */
export function getAppProvider(
  config: AppConfig,
  providerId: string,
): AppProviderConfig | undefined {
  return config.providers.find((provider) => provider.id === providerId)
}

/** Selects the active application provider, falling back to the first configured provider. */
export function getActiveAppProvider(config: AppConfig): AppProviderConfig {
  return (
    getAppProvider(config, config.activeProviderId) ??
    config.providers[0] ??
    DEFAULT_APP_CONFIG.providers[0]
  )
}

/** Projects privileged configuration into renderer-safe public settings and credential metadata. */
export function toPublicConfig(
  config: AppConfig,
  credentialConfigured: boolean,
  credentialSource?: ProviderPublicConfig['credentialSource'],
  webSearchCredential?: Pick<
    PublicConfig['webSearch'],
    'credentialConfigured' | 'credentialSource'
  >,
): PublicConfig
export function toPublicConfig(
  config: AppConfig,
  credentialForProvider: (
    provider: AppProviderConfig,
  ) => Pick<ProviderPublicConfig, 'credentialConfigured' | 'credentialSource'>,
  credentialSource?: ProviderPublicConfig['credentialSource'],
  webSearchCredential?: Pick<
    PublicConfig['webSearch'],
    'credentialConfigured' | 'credentialSource'
  >,
): PublicConfig
export function toPublicConfig(
  config: AppConfig,
  credential:
    | boolean
    | ((
        provider: AppProviderConfig,
      ) => Pick<
        ProviderPublicConfig,
        'credentialConfigured' | 'credentialSource'
      >),
  credentialSource: ProviderPublicConfig['credentialSource'] = 'safe-storage',
  webSearchCredential: Pick<
    PublicConfig['webSearch'],
    'credentialConfigured' | 'credentialSource'
  > = { credentialConfigured: false, credentialSource: 'none' },
): PublicConfig {
  const credentialForProvider =
    typeof credential === 'function'
      ? credential
      : () => ({
          credentialConfigured: credential,
          credentialSource: credential ? credentialSource : 'none',
        })

  return {
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      providerType: provider.providerType,
      revision: provider.revision,
      baseURL: provider.baseURL,
      model: provider.model,
      reasoning: provider.reasoning,
      modelCatalog: structuredClone(provider.modelCatalog),
      modelCatalogFetchedAt: provider.modelCatalogFetchedAt,
      modelOverrides: structuredClone(provider.modelOverrides),
      enabledModelIds: structuredClone(provider.enabledModelIds),
      ...credentialForProvider(provider),
    })),
    approval: structuredClone(config.approval),
    subagents: structuredClone(config.subagents),
    modelPool: structuredClone(config.modelPool),
    permission: structuredClone(config.permission),
    limits: structuredClone(config.limits),
    logging: structuredClone(config.logging),
    privacy: structuredClone(config.privacy),
    workspace: structuredClone(config.workspace),
    skills: structuredClone(config.skills),
    assistant: structuredClone(config.assistant),
    prompts: structuredClone(config.prompts),
    network: structuredClone(config.network),
    webSearch: {
      provider: config.webSearch.provider,
      count: config.webSearch.count,
      ...webSearchCredential,
    },
    mcpServers: structuredClone(config.mcpServers),
  }
}
