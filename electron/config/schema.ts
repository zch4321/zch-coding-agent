import { Type, type Static } from '@sinclair/typebox'
import {
  DeepSeekReasoningEffortSchema,
  PermissionModeSchema,
  PublicConfigSchema,
  RememberedRuleSchema,
  type PublicConfig,
} from '../../shared/config'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_SYSTEM_PROMPT_REFS,
} from '../../shared/prompt-resources'
import { DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'

export const AppConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    activeProvider: Type.Literal('deepseek'),
    providers: Type.Object(
      {
        deepseek: Type.Object(
          {
            baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
            model: Type.String({ minLength: 1, maxLength: 256 }),
            modelCatalog:
              PublicConfigSchema.properties.providers.properties.deepseek
                .properties.modelCatalog,
            modelCatalogFetchedAt: Type.Optional(
              Type.String({ format: 'date-time' }),
            ),
            modelOverrides:
              PublicConfigSchema.properties.providers.properties.deepseek
                .properties.modelOverrides,
            apiKeyRef: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
            reasoning: DeepSeekReasoningEffortSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
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

export const DEFAULT_APP_CONFIG = {
  schemaVersion: 2,
  activeProvider: 'deepseek',
  providers: {
    deepseek: {
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      modelCatalog: [],
      modelOverrides: {},
      reasoning: 'high',
    },
  },
  approval: {
    approverProvider: 'deepseek',
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
  },
  network: {
    httpProxy: { mode: 'off' },
  },
} satisfies AppConfig

export function toPublicConfig(
  config: AppConfig,
  credentialConfigured: boolean,
  credentialSource: PublicConfig['providers']['deepseek']['credentialSource'] = credentialConfigured
    ? 'safe-storage'
    : 'none',
): PublicConfig {
  return {
    schemaVersion: 2,
    activeProvider: config.activeProvider,
    providers: {
      deepseek: {
        baseURL: config.providers.deepseek.baseURL,
        model: config.providers.deepseek.model,
        reasoning: config.providers.deepseek.reasoning,
        modelCatalog: structuredClone(config.providers.deepseek.modelCatalog),
        modelCatalogFetchedAt: config.providers.deepseek.modelCatalogFetchedAt,
        modelOverrides: structuredClone(
          config.providers.deepseek.modelOverrides,
        ),
        credentialConfigured,
        credentialSource,
      },
    },
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
