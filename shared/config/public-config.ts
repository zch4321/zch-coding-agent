import { Type, type Static } from '@sinclair/typebox'
import type { ReasoningEffort } from '../reasoning'
import { LoggingConfigSchema, WorkspaceConfigSchema } from './application'
import { AssistantConfigSchema, PromptsConfigSchema } from './assistant'
import {
  McpServersConfigSchema,
  SkillsConfigSchema,
  WebSearchConfigSchema,
} from './integrations'
import { ModelsConfigSchema } from './models'
import { NetworkConfigSchema } from './network'
import type { ProviderPublicConfig } from './providers'
import {
  ExecutionEnvironmentConfigSchema,
  LimitsConfigSchema,
  SubagentsConfigSchema,
} from './runtime'
import { PermissionConfigSchema, PrivacyConfigSchema } from './security'

export const APP_CONFIG_SCHEMA_VERSION = 25 as const

export const PublicConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(APP_CONFIG_SCHEMA_VERSION),
    models: ModelsConfigSchema,
    subagents: SubagentsConfigSchema,
    executionEnvironment: ExecutionEnvironmentConfigSchema,
    permission: PermissionConfigSchema,
    limits: LimitsConfigSchema,
    logging: LoggingConfigSchema,
    privacy: PrivacyConfigSchema,
    workspace: WorkspaceConfigSchema,
    skills: SkillsConfigSchema,
    assistant: AssistantConfigSchema,
    prompts: PromptsConfigSchema,
    network: NetworkConfigSchema,
    webSearch: WebSearchConfigSchema,
    mcpServers: McpServersConfigSchema,
  },
  { additionalProperties: false },
)
export type PublicConfig = Static<typeof PublicConfigSchema>

/** Finds the configured provider with the given ID. */
export function getProviderConfig(
  config: PublicConfig,
  providerId: string,
): ProviderPublicConfig | undefined {
  return config.models.providers.find((provider) => provider.id === providerId)
}

/** Selects the default-model provider, falling back to the first configured provider. */
export function getDefaultModelProviderConfig(
  config: PublicConfig,
): ProviderPublicConfig {
  return (
    getProviderConfig(config, config.models.defaultModelProvider) ??
    config.models.providers[0]
  )
}

/** Builds the default model selection used for new conversations and auxiliary fallbacks. */
export function getDefaultModelSelection(config: PublicConfig): {
  providerId: string
  model: string
  reasoning: ReasoningEffort
} {
  const provider = getDefaultModelProviderConfig(config)
  return {
    providerId: provider.id,
    model: config.models.defaultModel || provider.model,
    reasoning: config.models.defaultModelReasoning,
  }
}

/** Builds the configured auxiliary model selection, undefined when unconfigured. */
export function getAuxiliaryModelSelection(config: PublicConfig):
  | {
      providerId: string
      model: string
      reasoning: ReasoningEffort
    }
  | undefined {
  const provider = getProviderConfig(
    config,
    config.models.auxiliaryModelProvider,
  )
  const model = config.models.auxiliaryModel
  if (!provider || !model) return undefined
  return {
    providerId: provider.id,
    model,
    reasoning: config.models.auxiliaryModelReasoning,
  }
}
