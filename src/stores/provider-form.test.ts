import { describe, expect, it } from 'vitest'
import type { ModelCapabilityLevel, ReasoningEffort } from '../../shared/config'
import type { UiModelProfile } from './agent-types'
import {
  DEFAULT_PROVIDER_FORM,
  providerDraftAuxiliaryConflict,
  providerFormSignature,
  providerModelOverrides,
} from './provider-form'

function profile(
  id: string,
  capabilitySource: UiModelProfile['capabilitySource'],
  annotation?: {
    reasoningEfforts?: ReasoningEffort[]
    capability?: ModelCapabilityLevel
  },
): UiModelProfile {
  return {
    id,
    availability: 'provider',
    capabilitySource,
    contextWindowTokens: 256_000,
    compactThresholdTokens: 198_246,
    maxOutputTokens: 8_192,
    ...annotation,
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

  it('serializes annotation-only rows without freezing token defaults', () => {
    expect(
      providerModelOverrides([
        profile('default-model', 'default'),
        profile('annotated-model', 'provider', {
          reasoningEfforts: ['low', 'high'],
          capability: 'strong',
        }),
        profile('capability-only-model', 'builtin', { capability: 'light' }),
      ]),
    ).toEqual({
      'annotated-model': {
        reasoningEfforts: ['low', 'high'],
        capability: 'strong',
      },
      'capability-only-model': { capability: 'light' },
    })
  })

  it('normalizes reasoning effort order during serialization', () => {
    expect(
      providerModelOverrides([
        profile('annotated-model', 'provider', {
          reasoningEfforts: ['max', 'low', 'high'],
        }),
      ]),
    ).toEqual({
      'annotated-model': { reasoningEfforts: ['low', 'high', 'max'] },
    })
  })

  it('carries annotations alongside explicit token overrides', () => {
    expect(
      providerModelOverrides([
        profile('edited-model', 'override', { reasoningEfforts: ['max'] }),
      ]),
    ).toEqual({
      'edited-model': {
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 8_192,
        reasoningEfforts: ['max'],
      },
    })
  })
})

describe('provider form signature', () => {
  it('changes when per-model annotations change', () => {
    const base = [profile('model-a', 'provider')]
    const baseSignature = providerFormSignature(DEFAULT_PROVIDER_FORM, base)

    expect(
      providerFormSignature(DEFAULT_PROVIDER_FORM, [
        profile('model-a', 'provider', { reasoningEfforts: ['low'] }),
      ]),
    ).not.toBe(baseSignature)
    expect(
      providerFormSignature(DEFAULT_PROVIDER_FORM, [
        profile('model-a', 'provider', { capability: 'standard' }),
      ]),
    ).not.toBe(baseSignature)
  })

  it('is stable for equivalent annotations regardless of effort order', () => {
    const first = providerFormSignature(DEFAULT_PROVIDER_FORM, [
      profile('model-a', 'provider', {
        reasoningEfforts: ['low', 'medium'],
        capability: 'light',
      }),
    ])
    const shuffled = providerFormSignature(DEFAULT_PROVIDER_FORM, [
      profile('model-a', 'provider', {
        reasoningEfforts: ['medium', 'low'],
        capability: 'light',
      }),
    ])
    expect(first).toBe(shuffled)
  })
})

describe('providerDraftAuxiliaryConflict', () => {
  const profiles = [
    profile('main-model', 'provider', { reasoningEfforts: ['low', 'high'] }),
    profile('approver-model', 'provider', { reasoningEfforts: ['low'] }),
  ]
  const base = {
    providerId: 'provider-a',
    enabledModelIds: ['main-model', 'approver-model'],
    profiles,
    auxiliary: {
      providerId: 'provider-a',
      model: 'approver-model',
      reasoning: 'low' as ReasoningEffort,
    },
  }

  it('reports no conflicts when both routes are compatible', () => {
    expect(providerDraftAuxiliaryConflict(base)).toEqual({
      conflict: false,
      reason: null,
    })
  })

  it('flags auxiliary when its explicit effort is unsupported', () => {
    expect(
      providerDraftAuxiliaryConflict({
        ...base,
        auxiliary: { ...base.auxiliary, reasoning: 'high' },
      }),
    ).toEqual({
      conflict: true,
      reason: 'reasoning-unsupported',
    })
  })

  it('accepts an explicit off effort when the auxiliary model supports it', () => {
    expect(
      providerDraftAuxiliaryConflict({
        ...base,
        profiles: [
          profile('main-model', 'provider', { reasoningEfforts: ['off'] }),
          profile('approver-model', 'provider', { reasoningEfforts: ['off'] }),
        ],
        auxiliary: { ...base.auxiliary, reasoning: 'off' },
      }),
    ).toEqual({
      conflict: false,
      reason: null,
    })
  })

  it('flags auxiliary when the saved auxiliary model is disabled in the draft', () => {
    expect(
      providerDraftAuxiliaryConflict({
        ...base,
        enabledModelIds: ['main-model'],
      }),
    ).toEqual({
      conflict: true,
      reason: 'model-disabled',
    })
  })

  it('ignores the auxiliary role when another provider hosts it', () => {
    expect(
      providerDraftAuxiliaryConflict({
        ...base,
        auxiliary: {
          providerId: 'provider-b',
          model: 'approver-model',
          reasoning: 'high',
        },
      }),
    ).toEqual({
      conflict: false,
      reason: null,
    })
  })
})
