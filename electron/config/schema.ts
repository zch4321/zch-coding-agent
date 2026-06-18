import { Type, type Static } from '@sinclair/typebox'
import {
  PublicConfigSchema,
  RememberedRuleSchema,
  type PublicConfig,
} from '../../shared/config'

export const AppConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    activeProvider: Type.Literal('deepseek'),
    providers: Type.Object(
      {
        deepseek: Type.Object(
          {
            baseURL: Type.String({ minLength: 1, maxLength: 2048 }),
            model: Type.String({ minLength: 1, maxLength: 256 }),
            apiKeyRef: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
            reasoning: Type.Union([Type.Literal('auto'), Type.Literal('off')]),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    approval: PublicConfigSchema.properties.approval,
    permission: Type.Object(
      {
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
  },
  { additionalProperties: false },
)

export type AppConfig = Static<typeof AppConfigSchema>

export const DEFAULT_APP_CONFIG = {
  schemaVersion: 1,
  activeProvider: 'deepseek',
  providers: {
    deepseek: {
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      reasoning: 'auto',
    },
  },
  approval: {
    approverProvider: 'deepseek',
    approverModel: 'deepseek-chat',
  },
  permission: {
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
    maxToolOutputBytes: 1_000_000,
    maxContextTokens: 64_000,
    commandTimeoutMs: 120_000,
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
} satisfies AppConfig

export function toPublicConfig(
  config: AppConfig,
  credentialConfigured: boolean,
): PublicConfig {
  return {
    schemaVersion: 1,
    activeProvider: config.activeProvider,
    providers: {
      deepseek: {
        baseURL: config.providers.deepseek.baseURL,
        model: config.providers.deepseek.model,
        reasoning: config.providers.deepseek.reasoning,
        credentialConfigured,
      },
    },
    approval: structuredClone(config.approval),
    permission: structuredClone(config.permission),
    limits: structuredClone(config.limits),
    logging: structuredClone(config.logging),
    privacy: structuredClone(config.privacy),
    workspace: structuredClone(config.workspace),
    skills: structuredClone(config.skills),
  }
}
