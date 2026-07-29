import { describe, expect, it } from 'vitest'
import { resolveModelTokenSettings } from './model-settings'

describe('model token settings', () => {
  it('fills the default output and compression limits for identity-only models', () => {
    expect(
      resolveModelTokenSettings({
        contextWindowTokens: 256_000,
        compactTriggerPercent: 80,
      }),
    ).toEqual({
      contextWindowTokens: 256_000,
      compactThresholdTokens: 152_371,
      maxOutputTokens: 65_536,
    })
  })

  it('clamps the default output to preserve a minimum prompt budget', () => {
    expect(
      resolveModelTokenSettings({
        contextWindowTokens: 64_000,
        compactTriggerPercent: 80,
      }),
    ).toEqual({
      contextWindowTokens: 64_000,
      compactThresholdTokens: 1_024,
      maxOutputTokens: 62_976,
    })
  })

  it('preserves valid model settings and clamps values to usable context', () => {
    expect(
      resolveModelTokenSettings({
        contextWindowTokens: 32_000,
        compactThresholdTokens: 31_000,
        maxOutputTokens: 40_000,
        compactTriggerPercent: 80,
      }),
    ).toEqual({
      contextWindowTokens: 32_000,
      compactThresholdTokens: 1_024,
      maxOutputTokens: 30_976,
    })
  })
})
