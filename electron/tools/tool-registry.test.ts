import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerOrchestrationTools } from '../session/orchestration-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

describe('ToolRegistry hard output boundary', () => {
  it('strips provider-only intent metadata again at the executor boundary', () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      id: 'grep_fixture',
      description: 'Search fixture',
      inputSchema: Type.Object(
        {
          pattern: Type.String(),
          include: Type.Optional(Type.String()),
          maxResults: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
      effects: ['filesystem.read'],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: [] }
      },
    })
    const intentParameter = registry.providerDefinitions()[0].intentParameter
    const call = {
      id: 'call-intent' as CallId,
      toolId: 'grep_fixture',
      args: {
        pattern: 'TODO|FIXME',
        include: '**/*.ts',
        maxResults: 100,
        [intentParameter]: 'Find unfinished work',
      },
      reason: '',
    }

    expect(registry.normalizeCall(call)).toEqual({
      ...call,
      args: {
        pattern: 'TODO|FIXME',
        include: '**/*.ts',
        maxResults: 100,
      },
      reason: 'Find unfinished work',
    })
    expect(new ToolExecutor(registry).inspectCall(call)).toMatchObject({
      ok: true,
    })
  })

  it('repairs scalar types and ignores undeclared provider parameters before approval', () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      id: 'normalize_fixture',
      description: 'Normalize fixture',
      inputSchema: Type.Object(
        {
          query: Type.String(),
          limit: Type.Integer({ minimum: 1, maximum: 100 }),
          literal: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      effects: ['filesystem.read'],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: [] }
      },
    })
    const executor = new ToolExecutor(registry)
    const raw = {
      id: 'call-normalize' as CallId,
      toolId: 'normalize_fixture',
      args: {
        query: 42,
        limit: '10',
        literal: 'false',
        hallucinated: 'ignored',
      },
      reason: 'Test normalization',
    }

    const normalized = executor.normalizeCall(raw)
    expect(normalized.args).toEqual({
      query: '42',
      limit: 10,
      literal: false,
    })
    expect(executor.inspectCall(normalized)).toMatchObject({ ok: true })
  })

  it('returns a field-specific retryable error when normalization cannot repair input', () => {
    const registry = new ToolRegistry()
    registry.registerTool({
      id: 'integer_fixture',
      description: 'Integer fixture',
      inputSchema: Type.Object(
        { count: Type.Integer() },
        { additionalProperties: false },
      ),
      effects: ['filesystem.read'],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: [] }
      },
    })

    const inspected = new ToolExecutor(registry).inspectCall({
      id: 'call-invalid' as CallId,
      toolId: 'integer_fixture',
      args: { count: 'many' },
      reason: 'Test error',
    })
    expect(inspected).toMatchObject({
      ok: false,
      result: {
        code: 'INVALID_TOOL_ARGS',
        message: expect.stringContaining('/count must be integer'),
        retryable: true,
      },
    })
  })

  it('requires result and evidence for completed plan_update calls', () => {
    const registry = new ToolRegistry()
    registerOrchestrationTools(registry, {
      getSession: () => undefined,
      emit: () => undefined,
    })
    const definition = registry.get('plan_update')

    expect(definition).toBeTruthy()
    expect(
      registry.validateArgs(definition!, {
        id: 'item:1',
        status: 'completed',
      }),
    ).toMatchObject({
      ok: false,
    })
    expect(
      registry.validateArgs(definition!, {
        id: 'item:1',
        status: 'completed',
        result: 'Done',
        evidence: 'Verified',
      }),
    ).toMatchObject({
      ok: true,
    })
    expect(
      registry.validateArgs(definition!, {
        id: 'item:1',
        status: 'cancelled',
      }),
    ).toMatchObject({
      ok: false,
    })
    expect(
      registry.validateArgs(definition!, {
        id: 'item:1',
        status: 'cancelled',
        cancelReason: 'No longer needed',
      }),
    ).toMatchObject({
      ok: true,
    })
  })

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
