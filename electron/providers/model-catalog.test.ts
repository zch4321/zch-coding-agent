import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
  type AppConfig,
} from '../config/schema'
import {
  fetchAnthropicModelCatalog,
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

  it('fetches paginated Anthropic models with native authentication', async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          'x-api-key': 'secret',
          'anthropic-version': '2023-06-01',
        })
        const endpoint = new URL(String(url))
        return new Response(
          JSON.stringify(
            endpoint.searchParams.get('after_id')
              ? {
                  data: [{ id: 'claude-b' }],
                  has_more: false,
                  last_id: 'claude-b',
                }
              : {
                  data: [
                    {
                      id: 'claude-a',
                      max_input_tokens: 200_000,
                      max_tokens: 64_000,
                    },
                  ],
                  has_more: true,
                  last_id: 'claude-a',
                },
          ),
          { status: 200 },
        )
      },
    ) as typeof fetch

    await expect(
      fetchAnthropicModelCatalog({
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        id: 'claude-a',
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
      },
      { id: 'claude-b' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects an oversized Anthropic pagination cursor', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [{ id: 'claude-a' }],
        has_more: true,
        last_id: 'x'.repeat(257),
      }),
    ) as typeof fetch

    await expect(
      fetchAnthropicModelCatalog({
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).rejects.toThrow('invalid model catalog cursor')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('cancels a streamed catalog as soon as its byte limit is exceeded', async () => {
    let cancelled = false
    const chunk = new Uint8Array(600_000)
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    await expect(
      fetchDeepSeekModelCatalog({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).rejects.toThrow('Provider model catalog is too large')
    expect(cancelled).toBe(true)
  })

  it('rejects an empty response body as an invalid catalog', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as typeof fetch

    await expect(
      fetchDeepSeekModelCatalog({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'secret',
        fetchImpl,
      }),
    ).rejects.toThrow('Provider returned an invalid model catalog')
  })

  it('uses override, provider, builtin and conservative capabilities in order', () => {
    const internal: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
    const provider = internal.providers[0]
    provider.model = 'custom-model'
    provider.modelCatalog = [
      { id: 'deepseek-v4-pro', ownedBy: 'deepseek' },
      { id: 'custom-model' },
      {
        id: 'provider-model',
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
      },
    ]
    provider.modelOverrides['custom-model'] = {
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
        expect.objectContaining({
          id: 'provider-model',
          capabilitySource: 'provider',
          contextWindowTokens: 200_000,
          maxOutputTokens: 64_000,
        }),
      ]),
    )
  })
})
