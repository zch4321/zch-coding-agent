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
})
