import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'
import { DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'

describe('config migrations', () => {
  it('maps the legacy automatic reasoning setting to DeepSeek high effort', () => {
    const legacy = {
      schemaVersion: 2,
      activeProvider: 'deepseek',
      providers: {
        deepseek: {
          baseURL: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          modelCatalog: [],
          modelOverrides: {},
          reasoning: 'auto',
        },
      },
      approval: {
        approverProvider: 'deepseek',
        approverModel: 'deepseek-chat',
      },
    }

    const migrated = migrateConfig(legacy)

    expect(migrated.providers[0].reasoning).toBe('high')
    expect(migrated.approval.approverProviderId).toBe('deepseek')
  })

  it('maps the mistakenly exposed low reasoning setting to DeepSeek high effort', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG)
    legacy.providers[0].reasoning = 'low' as never

    expect(migrateConfig(legacy).providers[0].reasoning).toBe('high')
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

  it('upgrades version-one configs to schema v3 defaults', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as Partial<
      typeof DEFAULT_APP_CONFIG
    >
    legacy.schemaVersion = 1 as never
    delete legacy.network
    delete legacy.prompts

    const migrated = migrateConfig(legacy)

    expect(migrated.schemaVersion).toBe(4)
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

  it('migrates a v3 config up to v4 with web search defaults', () => {
    const v3 = structuredClone(DEFAULT_APP_CONFIG)
    v3.schemaVersion = 3 as never
    delete (v3 as { webSearch?: unknown }).webSearch

    const migrated = migrateConfig(v3)

    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.webSearch).toEqual({
      provider: 'brave',
      count: 5,
    })
  })
})
