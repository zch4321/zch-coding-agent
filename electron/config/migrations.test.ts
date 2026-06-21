import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'

describe('config migrations', () => {
  it('maps the legacy automatic reasoning setting to DeepSeek high effort', () => {
    const legacy = structuredClone(DEFAULT_APP_CONFIG) as unknown as {
      providers: { deepseek: { reasoning: string } }
    }
    legacy.providers.deepseek.reasoning = 'auto'

    expect(migrateConfig(legacy).providers.deepseek.reasoning).toBe('high')
  })
})
