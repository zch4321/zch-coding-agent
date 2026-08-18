/**
 * Backwards-compatible config facade.
 *
 * New domain code should import from `shared/config/<domain>`; existing callers
 * can keep this entry while the wider IPC contract is split independently.
 */
export {
  AssistantLanguageSchema,
  PromptResourceRefSchema,
  type AssistantLanguage,
} from './config/assistant'
export {
  ConfigSectionSchema,
  ConfigSetRequestSchema,
  type ConfigSection,
  type ConfigSetRequest,
} from './config/config-requests'
export {
  ModelRolesConfigSchema,
  ModelsConfigSchema,
  type ModelRolesConfig,
  type ModelsConfig,
} from './config/models'
export { HttpProxyConfigSchema, type HttpProxyConfig } from './config/network'
export {
  DeepSeekReasoningEffortSchema,
  ModelCapabilityLevelSchema,
  ModelCapabilityOverrideSchema,
  ProviderModelSchema,
  ProviderPublicConfigSchema,
  ProviderTypeSchema,
  type DeepSeekReasoningEffort,
  type ModelCapabilityLevel,
  type ModelCapabilityOverride,
  type ProviderModel,
  type ProviderPublicConfig,
  type ProviderType,
} from './config/providers'
export {
  APP_CONFIG_SCHEMA_VERSION,
  PublicConfigSchema,
  getAuxiliaryModelSelection,
  getDefaultModelProviderConfig,
  getDefaultModelSelection,
  getProviderConfig,
  type PublicConfig,
} from './config/public-config'
export { TokenEstimationSchema } from './config/runtime'
export {
  PermissionModeSchema,
  RememberedRuleSchema,
  type PermissionMode,
  type RememberedRule,
} from './config/security'
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
