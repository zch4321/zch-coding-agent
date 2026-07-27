import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import { normalizeLlmUsage } from './usage'

describe('normalizeLlmUsage', () => {
  it('attributes usage to the resolved model instead of the provider default', () => {
    const config = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
    config.providers[0]!.model = 'provider-default'
    config.providers[0]!.modelOverrides['selected-model'] = {
      contextWindowTokens: 123_456,
    }
    const publicConfig = toPublicConfig(config, true)

    expect(
      normalizeLlmUsage({
        scope: 'main',
        config: publicConfig,
        provider: publicConfig.providers[0]!,
        model: 'selected-model',
        usage: {
          totalTokens: 42,
          raw: { total_tokens: 42 },
        },
      }),
    ).toMatchObject({
      model: 'selected-model',
      totalTokens: 42,
      contextWindowTokens: 123_456,
      contextWindowSource: 'override',
    })
  })
})
