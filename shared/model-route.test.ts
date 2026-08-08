import { describe, expect, it } from 'vitest'
import { evaluateModelRouteCompatibility } from './model-route'

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
})
