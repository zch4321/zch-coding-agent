import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APP_CONFIG_SCHEMA_VERSION,
  ModelCapabilityOverrideSchema as FacadeModelCapabilityOverrideSchema,
  PublicConfigSchema as FacadePublicConfigSchema,
} from './config'
import {
  LoggingConfigSchema,
  WorkspaceConfigSchema,
} from './config/application'
import { AssistantConfigSchema, PromptsConfigSchema } from './config/assistant'
import {
  McpServersConfigSchema,
  SkillsConfigSchema,
  WebSearchConfigSchema,
} from './config/integrations'
import { ModelsConfigSchema } from './config/models'
import { NetworkConfigSchema } from './config/network'
import {
  ModelCapabilityOverrideSchema,
  ProviderPublicConfigSchema,
} from './config/providers'
import { PublicConfigSchema } from './config/public-config'
import {
  ExecutionEnvironmentConfigSchema,
  LimitsConfigSchema,
  SubagentsConfigSchema,
} from './config/runtime'
import { PermissionConfigSchema, PrivacyConfigSchema } from './config/security'

function schemaHash(schema: object): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

describe('shared config contracts', () => {
  it('preserves the v22 schema fingerprint across the domain split', () => {
    expect(APP_CONFIG_SCHEMA_VERSION).toBe(22)
    expect(schemaHash(PublicConfigSchema)).toBe(
      '084559018332e66420860fa4f14d83fe9417c1212d039c8ada2bbb9dd30420b4',
    )
  })

  it('composes the public schema from the eight domain schemas', () => {
    expect(FacadePublicConfigSchema).toBe(PublicConfigSchema)
    expect(FacadeModelCapabilityOverrideSchema).toBe(
      ModelCapabilityOverrideSchema,
    )
    expect(PublicConfigSchema.properties.models).toBe(ModelsConfigSchema)
    expect(ModelsConfigSchema.properties.providers.items).toBe(
      ProviderPublicConfigSchema,
    )

    expect(PublicConfigSchema.properties.subagents).toBe(SubagentsConfigSchema)
    expect(PublicConfigSchema.properties.executionEnvironment).toBe(
      ExecutionEnvironmentConfigSchema,
    )
    expect(PublicConfigSchema.properties.limits).toBe(LimitsConfigSchema)

    expect(PublicConfigSchema.properties.permission).toBe(
      PermissionConfigSchema,
    )
    expect(PublicConfigSchema.properties.privacy).toBe(PrivacyConfigSchema)
    expect(PublicConfigSchema.properties.assistant).toBe(AssistantConfigSchema)
    expect(PublicConfigSchema.properties.prompts).toBe(PromptsConfigSchema)

    expect(PublicConfigSchema.properties.skills).toBe(SkillsConfigSchema)
    expect(PublicConfigSchema.properties.webSearch).toBe(WebSearchConfigSchema)
    expect(PublicConfigSchema.properties.mcpServers).toBe(
      McpServersConfigSchema,
    )
    expect(PublicConfigSchema.properties.network).toBe(NetworkConfigSchema)
    expect(PublicConfigSchema.properties.logging).toBe(LoggingConfigSchema)
    expect(PublicConfigSchema.properties.workspace).toBe(WorkspaceConfigSchema)
  })
})
