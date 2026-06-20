import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import {
  fetchDeepSeekModelCatalog,
  modelCatalogEndpoint,
  resolveModelProfiles,
} from './model-catalog'

describe('DeepSeek model catalog', () => {
  it('joins the models endpoint to root and versioned base URLs', () => {
    expect(modelCatalogEndpoint('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/models',
    )
    expect(modelCatalogEndpoint('https://example.test/v1')).toBe(
      'https://example.test/v1/models',
    )
  })

  it('fetches, validates, deduplicates and sorts provider models', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer secret',
        })
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'model-b', object: 'model', owned_by: 'deepseek' },
              { id: 'model-a', object: 'model', owned_by: 'deepseek' },
              { id: 'model-a', object: 'model', owned_by: 'deepseek' },
              { object: 'model' },
            ],
          }),
          { status: 200 },
        )
      },
    ) as typeof fetch

    await expect(
      fetchDeepSeekModelCatalog({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).resolves.toEqual([
      { id: 'model-a', ownedBy: 'deepseek' },
      { id: 'model-b', ownedBy: 'deepseek' },
    ])
  })

  it('reports authentication failures without exposing response bodies', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('credential sentinel', { status: 401 }),
    ) as typeof fetch

    await expect(
      fetchDeepSeekModelCatalog({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ModelCatalogError',
        status: 401,
        message: 'Provider model catalog request failed with status 401',
      }),
    )
  })

  it('uses override, builtin and conservative capability sources in order', () => {
    const internal: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
    internal.providers.deepseek.model = 'custom-model'
    internal.providers.deepseek.modelCatalog = [
      { id: 'deepseek-v4-pro', ownedBy: 'deepseek' },
      { id: 'custom-model' },
    ]
    internal.providers.deepseek.modelOverrides['custom-model'] = {
      contextWindowTokens: 123_456,
      maxOutputTokens: 7_000,
    }
    const profiles = resolveModelProfiles(toPublicConfig(internal, true))

    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek-v4-pro',
          capabilitySource: 'builtin',
          contextWindowTokens: 1_000_000,
        }),
        expect.objectContaining({
          id: 'custom-model',
          capabilitySource: 'override',
          contextWindowTokens: 123_456,
          maxOutputTokens: 7_000,
        }),
      ]),
    )
  })
})
