import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'
import { DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'

describe('config migrations', () => {
  it('maps the legacy automatic reasoning setting to DeepSeek high effort', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as unknown as {
      providers: { deepseek: { reasoning: string } }
    }
    legacy.providers.deepseek.reasoning = 'auto'

    expect(migrateConfig(legacy).providers.deepseek.reasoning).toBe('high')
  })

  it('adds localized system prompts to existing version-one configs', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as Partial<
      typeof DEFAULT_APP_CONFIG
    >
    delete legacy.assistant

    expect(migrateConfig(legacy).assistant).toEqual({
      language: 'zh-CN',
      systemPrompts: DEFAULT_SYSTEM_PROMPTS,
    })
  })

  it('upgrades version-one configs to schema v2 defaults', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as Partial<
      typeof DEFAULT_APP_CONFIG
    >
    legacy.schemaVersion = 1 as never
    delete legacy.network
    delete legacy.prompts

    const migrated = migrateConfig(legacy)

    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.network.httpProxy).toEqual({ mode: 'off' })
    expect(migrated.prompts.approval.classifyRisk.id).toBe(
      'approval.classify-risk',
    )
    expect(migrated.limits).toMatchObject({
      approvalTimeoutMs: 600_000,
      autoApprovalTimeoutMs: 15_000,
      modelCatalogTimeoutMs: 15_000,
    })
  })
})
