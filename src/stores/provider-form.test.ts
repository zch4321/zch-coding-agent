import { describe, expect, it } from 'vitest'
import type { UiModelProfile } from './agent-types'
import { providerModelOverrides } from './provider-form'

function profile(
  id: string,
  capabilitySource: UiModelProfile['capabilitySource'],
): UiModelProfile {
  return {
    id,
    availability: 'provider',
    capabilitySource,
    contextWindowTokens: 256_000,
    compactThresholdTokens: 198_246,
    maxOutputTokens: 8_192,
  }
}

describe('provider model overrides', () => {
  it('persists edited rows without freezing generated defaults', () => {
    expect(
      providerModelOverrides([
        profile('default-model', 'default'),
        profile('provider-model', 'provider'),
        profile('builtin-model', 'builtin'),
        profile('edited-model', 'override'),
      ]),
    ).toEqual({
      'edited-model': {
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 8_192,
      },
    })
  })
})
