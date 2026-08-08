import { describe, expect, it } from 'vitest'
import type { ModelRouteSnapshot } from './model-route'
import {
  areModelRoutesHistoryCompatible,
  evaluateModelRouteCompatibility,
  modelRouteCompatibilityKey,
} from './model-route'

const provider = {
  enabledModelIds: ['unannotated', 'limited'],
  modelOverrides: {
    limited: { reasoningEfforts: ['low', 'high'] as const },
  },
}

describe('model route compatibility', () => {
  it('reports missing providers, empty models and disabled models distinctly', () => {
    expect(
      evaluateModelRouteCompatibility(undefined, {
        model: 'unannotated',
        reasoning: 'high',
      }),
    ).toEqual({ ok: false, reason: 'provider-missing' })
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: '',
        reasoning: 'high',
      }),
    ).toEqual({ ok: false, reason: 'model-empty' })
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: 'disabled',
        reasoning: 'high',
      }),
    ).toEqual({ ok: false, reason: 'model-disabled' })
  })

  it('accepts every effort for unannotated enabled models', () => {
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: 'unannotated',
        reasoning: 'off',
      }),
    ).toEqual({ ok: true })
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: 'unannotated',
        reasoning: 'max',
      }),
    ).toEqual({ ok: true })
  })

  it('returns the normalized supported efforts for annotation conflicts', () => {
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: 'limited',
        reasoning: 'max',
      }),
    ).toEqual({
      ok: false,
      reason: 'reasoning-unsupported',
      supportedReasoningEfforts: ['low', 'high'],
    })
    expect(
      evaluateModelRouteCompatibility(provider, {
        model: 'limited',
        reasoning: 'low',
      }),
    ).toEqual({ ok: true })
  })

  it('keys opaque history by Provider implementation, model, endpoint and revision', () => {
    const route: ModelRouteSnapshot = {
      schemaVersion: 2,
      purpose: 'main',
      providerType: 'generic.responses',
      providerId: 'openai',
      model: 'gpt-5.6',
      reasoning: 'high',
      endpoint: 'https://api.openai.com/v1/responses',
      providerConfigRevision: 4,
    }
    const compression = {
      ...route,
      purpose: 'compression' as const,
      reasoning: 'low' as const,
    }

    expect(modelRouteCompatibilityKey(compression)).toBe(
      modelRouteCompatibilityKey(route),
    )
    expect(areModelRoutesHistoryCompatible(route, compression)).toBe(true)
    expect(
      areModelRoutesHistoryCompatible(route, {
        ...route,
        model: 'gpt-5.5',
      }),
    ).toBe(false)
    expect(
      areModelRoutesHistoryCompatible(route, {
        ...route,
        providerConfigRevision: 5,
      }),
    ).toBe(false)
  })
})
