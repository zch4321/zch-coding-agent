import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerWebSearchTools } from './web-search-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

function fakeStore(options: { hasKey: boolean }) {
  const publicConfig = toPublicConfig(DEFAULT_APP_CONFIG, false, undefined, {
    credentialConfigured: options.hasKey,
    credentialSource: options.hasKey ? 'safe-storage' : 'none',
  })

  return {
    getPublicConfig: () => publicConfig,
    async getWebSearchApiKey() {
      return options.hasKey ? 'fake-brave-key' : undefined
    },
  }
}

async function executeWebSearch(
  args: Record<string, unknown>,
  hasKey: boolean,
) {
  const registry = new ToolRegistry()
  registerWebSearchTools(registry, fakeStore({ hasKey }))
  const executor = new ToolExecutor(registry)
  const signal = new AbortController().signal
  const call = {
    id: 'call-web-search' as CallId,
    toolId: 'web_search',
    args: args as never,
    reason: '',
  }
  const inspected = executor.inspectCall(call)
  if (!inspected.ok) {
    return inspected.result
  }

  const context = {
    sessionId: 's' as SessionId,
    runId: 'r' as RunId,
    workspace: { canonicalPath: 'F:/workspace' },
  }
  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: 'F:/workspace',
    mode: 'yolo',
    call,
    definition: registry.get('web_search')!,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
}

describe('web_search tool', () => {
  it('registers as a network.request, review-risk tool', () => {
    const registry = new ToolRegistry()
    registerWebSearchTools(registry, fakeStore({ hasKey: false }))
    const definition = registry.get('web_search')
    expect(definition?.effects).toEqual(['network.request'])
    expect(definition?.defaultRisk).toBe('review')
  })

  it('returns NO_API_KEY when no key is configured', async () => {
    const result = await executeWebSearch({ query: 'test' }, false)
    expect(result).toMatchObject({
      status: 'error',
      code: 'NO_API_KEY',
    })
  })
})
