import { describe, expect, it } from 'vitest'
import type { ModelCapabilityLevel, ReasoningEffort } from '../../shared/config'
import type { UiModelProfile } from './agent-types'
import {
  DEFAULT_PROVIDER_FORM,
  providerDraftConflicts,
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

describe('providerDraftConflicts', () => {
  const profiles = [
    profile('main-model', 'provider', { reasoningEfforts: ['low', 'high'] }),
    profile('approver-model', 'provider', { reasoningEfforts: ['low'] }),
  ]
  const base = {
    providerId: 'provider-a',
    reasoning: 'low' as ReasoningEffort,
    mainModelId: 'main-model',
    enabledModelIds: ['main-model', 'approver-model'],
    profiles,
    approval: {
      providerId: 'provider-a',
      model: 'approver-model',
      reasoning: 'low' as ReasoningEffort,
    },
  }

  it('reports no conflicts when both routes are compatible', () => {
    expect(providerDraftConflicts(base)).toEqual({
      main: false,
      approval: false,
      approvalReason: null,
    })
  })

  it('flags main when the main model annotation excludes the default effort', () => {
    expect(providerDraftConflicts({ ...base, reasoning: 'medium' })).toEqual({
      main: true,
      approval: false,
      approvalReason: null,
    })
  })

  it('flags approval when its own configured effort is unsupported', () => {
    expect(
      providerDraftConflicts({
        ...base,
        reasoning: 'high',
        approval: { ...base.approval, reasoning: 'high' },
      }),
    ).toEqual({
      main: false,
      approval: true,
      approvalReason: 'reasoning-unsupported',
    })
  })

  it('does not inherit a changed Provider default effort', () => {
    expect(providerDraftConflicts({ ...base, reasoning: 'high' })).toEqual({
      main: false,
      approval: false,
      approvalReason: null,
    })
  })

  it('uses approval off exactly without promoting it to high', () => {
    expect(
      providerDraftConflicts({
        ...base,
        profiles: [
          ...profiles.slice(0, 1),
          profile('approver-model', 'provider', {
            reasoningEfforts: ['off'],
          }),
        ],
        approval: { ...base.approval, reasoning: 'off' },
      }),
    ).toEqual({
      main: false,
      approval: false,
      approvalReason: null,
    })
  })

  it('keeps main and approval conflicts independent', () => {
    expect(
      providerDraftConflicts({
        ...base,
        reasoning: 'off',
        approval: { ...base.approval, reasoning: 'high' },
      }),
    ).toEqual({
      main: true,
      approval: true,
      approvalReason: 'reasoning-unsupported',
    })
  })

  it('flags approval when the saved approval model is disabled in the draft', () => {
    expect(
      providerDraftConflicts({
        ...base,
        enabledModelIds: ['main-model'],
      }),
    ).toEqual({
      main: false,
      approval: true,
      approvalReason: 'model-disabled',
    })
  })

  it('ignores the approval route when another provider is the approver', () => {
    expect(
      providerDraftConflicts({
        ...base,
        approval: {
          providerId: 'provider-b',
          model: 'approver-model',
          reasoning: 'low',
        },
      }),
    ).toEqual({ main: false, approval: false, approvalReason: null })
  })

  it('treats unannotated models as supporting every effort', () => {
    expect(
      providerDraftConflicts({
        ...base,
        reasoning: 'max',
        profiles: [profile('main-model', 'provider')],
        approval: {
          providerId: 'provider-a',
          model: 'main-model',
          reasoning: 'max',
        },
      }),
    ).toEqual({ main: false, approval: false, approvalReason: null })
  })
})
