import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from './permission-pipeline'
import { registerFetchTools } from './fetch-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

function harness() {
  const registry = new ToolRegistry()
  registerFetchTools(registry, () => toPublicConfig(DEFAULT_APP_CONFIG, false))
  return { registry, executor: new ToolExecutor(registry) }
}

async function execute(args: Record<string, unknown>) {
  const { executor, registry } = harness()
  const signal = new AbortController().signal
  const call = {
    id: 'call-fetch' as CallId,
    toolId: 'fetch',
    args: args as JsonValue,
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
  // yolo auto-allows the side effect so the tool actually runs and we can
  // observe the SSRF guard rejections it surfaces.
  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: 'F:/workspace',
    mode: 'yolo',
    call,
    definition: registry.get('fetch')!,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
}

describe('fetch tool', () => {
  it('registers as a network.request, review-risk tool', () => {
    const { registry } = harness()
    const definition = registry.get('fetch')
    expect(definition?.effects).toEqual(['network.request'])
    expect(definition?.defaultRisk).toBe('review')
    expect(definition?.supportsAbort).toBe(true)
  })

  it('rejects http URLs because only https is allowed', async () => {
    const result = await execute({ url: 'http://example.com/' })
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_URL' })
  })

  it('rejects private addresses with SSRF guard', async () => {
    const result = await execute({ url: 'https://127.0.0.1/' })
    expect(result).toMatchObject({ status: 'error', code: 'PRIVATE_ADDRESS' })
  })

  it('rejects URLs with embedded credentials', async () => {
    const result = await execute({ url: 'https://token:x@example.com/' })
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_URL' })
  })
})
