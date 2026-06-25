import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'
import { LEGACY_DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'

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

  it('adds empty assistant preferences to existing version-one configs', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as Partial<
      typeof DEFAULT_APP_CONFIG
    >
    delete legacy.assistant

    expect(migrateConfig(legacy).assistant).toEqual({
      language: 'zh-CN',
      preferences: {
        'zh-CN': '',
        'en-US': '',
      },
    })
  })

  it('migrates custom legacy system prompts into assistant preferences', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as unknown as {
      schemaVersion: number
      assistant: {
        language: 'zh-CN'
        systemPrompts: Record<'zh-CN' | 'en-US', string>
      }
    }
    legacy.schemaVersion = 4
    legacy.assistant = {
      language: 'zh-CN',
      systemPrompts: {
        'zh-CN': '中文偏好',
        'en-US': LEGACY_DEFAULT_SYSTEM_PROMPTS['en-US'],
      },
    }

    expect(migrateConfig(legacy).assistant).toEqual({
      language: 'zh-CN',
      preferences: {
        'zh-CN': '中文偏好',
        'en-US': '',
      },
    })
  })

  it('upgrades version-one configs to current defaults', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as Partial<
      typeof DEFAULT_APP_CONFIG
    >
    legacy.schemaVersion = 1 as never
    delete legacy.network
    delete legacy.prompts

    const migrated = migrateConfig(legacy)

    expect(migrated.schemaVersion).toBe(5)
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

  it('migrates a v3 config up to v5 with web search defaults', () => {
    const v3 = structuredClone(DEFAULT_APP_CONFIG)
    v3.schemaVersion = 3 as never
    delete (v3 as { webSearch?: unknown }).webSearch

    const migrated = migrateConfig(v3)

    expect(migrated.schemaVersion).toBe(5)
    expect(migrated.webSearch).toEqual({
      provider: 'brave',
      count: 5,
    })
  })

  it('normalizes a removed web search provider and clears its credential ref', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as unknown as {
      schemaVersion: number
      webSearch: { provider: string; apiKeyRef?: string; count: number }
    }
    legacy.schemaVersion = 4
    legacy.webSearch.provider = 'serper'
    legacy.webSearch.apiKeyRef = 'secret:serper-key'

    const migrated = migrateConfig(legacy)

    expect(migrated.webSearch.provider).toBe('brave')
    expect(migrated.webSearch.apiKeyRef).toBeUndefined()
  })
})
