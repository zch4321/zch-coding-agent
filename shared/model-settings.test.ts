import { describe, expect, it } from 'vitest'
import { resolveModelTokenSettings } from './model-settings'

describe('model token settings', () => {
  it('fills safe output and compression defaults for identity-only models', () => {
    expect(
      resolveModelTokenSettings({
        contextWindowTokens: 64_000,
        compactTriggerPercent: 80,
      }),
    ).toEqual({
      contextWindowTokens: 64_000,
      compactThresholdTokens: 44_646,
      maxOutputTokens: 8_192,
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
