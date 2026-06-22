import { Type, type Static } from '@sinclair/typebox'
import {
  PermissionModeSchema,
  ProviderProfileSchema,
  ProviderProtocolSchema,
  PublicConfigSchema,
  ReasoningEffortSchema,
  RememberedRuleSchema,
  type ProviderPublicConfig,
  type PublicConfig,
} from '../../shared/config'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_ORCHESTRATION_PROMPT_REFS,
  DEFAULT_SYSTEM_PROMPT_REFS,
} from '../../shared/prompt-resources'
import { DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'

export const AppProviderConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    protocol: ProviderProtocolSchema,
    profile: ProviderProfileSchema,
    baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: ReasoningEffortSchema,
    modelCatalog: Type.Array(
      PublicConfigSchema.properties.providers.items.properties.modelCatalog
        .items,
      { maxItems: 1_000 },
    ),
    modelCatalogFetchedAt: Type.Optional(Type.String({ format: 'date-time' })),
    modelOverrides:
      PublicConfigSchema.properties.providers.items.properties.modelOverrides,
    apiKeyRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)

export type AppProviderConfig = Static<typeof AppProviderConfigSchema>

export const AppConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(3),
    activeProviderId: Type.String({ minLength: 1, maxLength: 128 }),
    providers: Type.Array(AppProviderConfigSchema, {
      minItems: 1,
      maxItems: 32,
    }),
    approval: PublicConfigSchema.properties.approval,
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
  },
  { additionalProperties: false },
)

export type AppConfig = Static<typeof AppConfigSchema>

export const DEFAULT_PROVIDER_ID = 'deepseek'

export const DEFAULT_APP_CONFIG = {
  schemaVersion: 3,
  activeProviderId: DEFAULT_PROVIDER_ID,
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      label: 'DeepSeek',
      protocol: 'openai-compatible',
      profile: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      modelCatalog: [],
      modelOverrides: {},
      reasoning: 'high',
    },
  ],
  approval: {
    approverProviderId: DEFAULT_PROVIDER_ID,
    approverModel: 'deepseek-chat',
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
    maxStepsPerRun: 24,
    maxToolOutputBytes: 64 * 1_024,
    maxContextTokens: 64_000,
    maxToolResultTokens: 8_000,
    maxToolTokensPerRun: 24_000,
    tokenEstimation: {
      mode: 'conservative',
      bytesPerToken: 3,
    },
    commandTimeoutMs: 120_000,
    readFileSourceBytes: 10_000_000,
    readFileOutputBytes: 64 * 1_024,
    editableFileBytes: 10_000_000,
    writeFileBytes: 256 * 1_024,
    patchBytes: 64 * 1_024,
    diffChars: 120_000,
    approvalTimeoutMs: 10 * 60_000,
    autoApprovalTimeoutMs: 15_000,
    modelCatalogTimeoutMs: 15_000,
    terminalScrollbackBytes: 2_000_000,
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
    systemPrompts: structuredClone(DEFAULT_SYSTEM_PROMPTS),
  },
  prompts: {
    system: structuredClone(DEFAULT_SYSTEM_PROMPT_REFS),
    approval: structuredClone(DEFAULT_APPROVAL_PROMPT_REFS),
    orchestration: structuredClone(DEFAULT_ORCHESTRATION_PROMPT_REFS),
  },
  network: {
    httpProxy: { mode: 'off' },
  },
} satisfies AppConfig

export function getAppProvider(
  config: AppConfig,
  providerId: string,
): AppProviderConfig | undefined {
  return config.providers.find((provider) => provider.id === providerId)
}

export function getActiveAppProvider(config: AppConfig): AppProviderConfig {
  return (
    getAppProvider(config, config.activeProviderId) ??
    config.providers[0] ??
    DEFAULT_APP_CONFIG.providers[0]
  )
}

export function toPublicConfig(
  config: AppConfig,
  credentialConfigured: boolean,
  credentialSource?: ProviderPublicConfig['credentialSource'],
): PublicConfig
export function toPublicConfig(
  config: AppConfig,
  credentialForProvider: (
    provider: AppProviderConfig,
  ) => Pick<ProviderPublicConfig, 'credentialConfigured' | 'credentialSource'>,
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
): PublicConfig {
  const credentialForProvider =
    typeof credential === 'function'
      ? credential
      : () => ({
          credentialConfigured: credential,
          credentialSource: credential ? credentialSource : 'none',
        })

  return {
    schemaVersion: 3,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      profile: provider.profile,
      baseURL: provider.baseURL,
      model: provider.model,
      reasoning: provider.reasoning,
      modelCatalog: structuredClone(provider.modelCatalog),
      modelCatalogFetchedAt: provider.modelCatalogFetchedAt,
      modelOverrides: structuredClone(provider.modelOverrides),
      ...credentialForProvider(provider),
    })),
    approval: structuredClone(config.approval),
    permission: structuredClone(config.permission),
    limits: structuredClone(config.limits),
    logging: structuredClone(config.logging),
    privacy: structuredClone(config.privacy),
    workspace: structuredClone(config.workspace),
    skills: structuredClone(config.skills),
    assistant: structuredClone(config.assistant),
    prompts: structuredClone(config.prompts),
    network: structuredClone(config.network),
  }
}
