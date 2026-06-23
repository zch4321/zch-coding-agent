import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { ToolExecutor, ToolRegistry } from './tool-registry'

describe('ToolRegistry hard output boundary', () => {
  it('bounds the final UTF-8 JSON result rather than JavaScript characters', async () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      id: 'unicode_output',
      description: 'Unicode output fixture',
      inputSchema: Type.Object({}, { additionalProperties: false }),
      effects: ['filesystem.read'],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: '😀'.repeat(10_000) }
      },
    })
    const call = {
      id: 'call-unicode' as CallId,
      toolId: 'unicode_output',
      args: {},
      reason: 'Test UTF-8 boundary',
    }
    const executor = new ToolExecutor(registry)
    const definition = registry.get(call.toolId)!
    const sessionId = 'session-unicode' as SessionId
    const runId = 'run-unicode' as RunId
    const signal = new AbortController().signal
    const approved = await new PermissionPipeline().authorize({
      sessionId,
      runId,
      workspace: process.cwd(),
      mode: 'readonly',
      call,
      definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal,
      requestHumanApproval: async () => ({ decision: 'deny' }),
    })

    expect(approved.ok).toBe(true)
    if (!approved.ok) {
      return
    }

    const result = await executor.execute(
      approved.approvedCall,
      { sessionId, runId, workspace: { canonicalPath: process.cwd() } },
      signal,
    )

    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(1_024)
    expect(result).toMatchObject({ status: 'ok', truncated: true })
  })
})
