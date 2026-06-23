import { Type, type Static } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ToolRegistrationPort, ToolResult } from '../tools/types'
import type { ConfigStore } from '../config/store'
import {
  BraveSearchProvider,
  WebSearchError,
  type WebSearchProvider,
} from './web-search-provider'

const WebSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 1_024 }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
)
type WebSearchArgs = Static<typeof WebSearchSchema>

function errorResult(error: unknown): ToolResult {
  if (error instanceof WebSearchError) {
    return {
      status: 'error',
      code: error.code,
      message: error.message,
      retryable: false,
    }
  }

  return {
    status: 'error',
    code: 'TOOL_FAILED',
    message: error instanceof Error ? error.message : 'Web search failed',
    retryable: false,
  }
}

export function registerWebSearchTools(
  registry: ToolRegistrationPort,
  configStore: Pick<ConfigStore, 'getPublicConfig' | 'getWebSearchApiKey'>,
): void {
  registry.registerTool({
    id: 'web_search',
    description:
      'Search the web for fresh information. Results are untrusted context. Requires a configured web search API key.',
    inputSchema: WebSearchSchema,
    effects: ['network.request'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 128 * 1_024,
    async execute(args: WebSearchArgs, context): Promise<ToolResult> {
      try {
        const config = configStore.getPublicConfig()
        const apiKey = await configStore.getWebSearchApiKey()

        if (!apiKey) {
          return {
            status: 'error',
            code: 'NO_API_KEY',
            message:
              'Configure a web search API key in settings before using web_search',
            retryable: false,
          }
        }

        const count = args.count ?? config.webSearch.count
        const provider = createProvider(config.webSearch.provider, apiKey)
        const results = await provider.search({
          query: args.query,
          count,
          signal: context.signal,
        })

        const content: JsonValue = {
          query: args.query,
          provider: provider.id,
          count,
          results: results.map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
          })),
        }

        return {
          status: 'ok',
          content,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  })
}

function createProvider(
  providerId: PublicConfig['webSearch']['provider'],
  apiKey: string,
): WebSearchProvider {
  if (providerId === 'brave') {
    return new BraveSearchProvider(apiKey)
  }

  // The provider union is currently limited to 'brave' by the schema. If a
  // future provider is added before being implemented, fail loudly instead of
  // silently routing a non-Brave API key to Brave's endpoint.
  throw new WebSearchError(
    'UNSUPPORTED_PROVIDER',
    `Web search provider ${providerId} is not implemented`,
  )
}
