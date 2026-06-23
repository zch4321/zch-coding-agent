import { fetchWithSsrfGuard } from '../net/ssrf'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchRequest {
  query: string
  count: number
  signal: AbortSignal
}

export interface WebSearchProvider {
  readonly id: string
  search(request: WebSearchRequest): Promise<WebSearchResult[]>
}

export class WebSearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WebSearchError'
  }
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string
      url?: string
      description?: string
    }>
  }
}

/**
 * Brave Search provider. Uses the Web Search API with an API key passed as the
 * X-Subscription-Token header. Requests go through the SSRF guard so the
 * fixed api.search.brave.com endpoint still gets redirect / private-address
 * protection, and responses are bounded in bytes and time.
 */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave'
  readonly #apiKey: string
  readonly #baseURL: string

  constructor(apiKey: string, baseURL = 'https://api.search.brave.com') {
    this.#apiKey = apiKey
    this.#baseURL = baseURL
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const url = new URL('/res/v1/web/search', this.#baseURL)
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(Math.min(request.count, 20)))

    let response

    try {
      response = await fetchWithSsrfGuard(url.href, {
        maxBytes: 512 * 1_024,
        timeoutMs: 20_000,
        maxRedirects: 3,
        allowedSchemes: ['https:'],
        signal: request.signal,
        headers: {
          'X-Subscription-Token': this.#apiKey,
          accept: 'application/json',
        },
      })
    } catch {
      throw new WebSearchError('SEARCH_FAILED', 'Web search request failed')
    }

    if (response.status !== 200) {
      throw new WebSearchError(
        'SEARCH_FAILED',
        `Search API returned status ${response.status}`,
      )
    }

    let parsed: BraveSearchResponse

    try {
      parsed = JSON.parse(response.body) as BraveSearchResponse
    } catch {
      throw new WebSearchError(
        'SEARCH_FAILED',
        'Search API returned invalid JSON',
      )
    }

    const results = parsed.web?.results ?? []

    return results
      .slice(0, request.count)
      .map((result) => ({
        title: result.title ?? '',
        url: result.url ?? '',
        snippet: result.description ?? '',
      }))
      .filter((result) => result.url)
  }
}
