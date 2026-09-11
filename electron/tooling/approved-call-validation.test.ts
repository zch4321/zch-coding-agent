import path from 'node:path'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { approvedCallBrand, type ApprovedToolCall } from './approved-tool-call'
import { createArgsHash } from './approved-call-validation'
import { ToolExecutor } from './executor'
import { ToolRegistry } from './registry'

describe('execution-time approval validation', () => {
  it.each([
    'brand',
    'session',
    'run',
    'arguments',
    'workspace',
    'temp',
    'unchanged',
  ])('checks %s before entering the registered handler', async (change) => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({
      status: 'ok' as const,
      content: 'done',
    }))
    registry.registerTool({
      id: 'fixture',
      description: 'Fixture',
      inputSchema: Type.Object({ value: Type.Number() }),
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1000,
      execute,
    })
    const approved: ApprovedToolCall = {
      [approvedCallBrand]: true,
      sessionId: 's' as SessionId,
      runId: 'r' as RunId,
      callId: 'c' as CallId,
      toolId: 'fixture',
      args: { value: 1 },
      argsHash: createArgsHash({ value: 1 }),
      workspace: process.cwd(),
      approvedBy: 'human',
      approvedAt: new Date().toISOString(),
    }
    if (change === 'brand') Reflect.deleteProperty(approved, approvedCallBrand)
    if (change === 'session') Reflect.set(approved, 'sessionId', 'other')
    if (change === 'run') Reflect.set(approved, 'runId', 'other')
    if (change === 'arguments') Reflect.set(approved, 'args', { value: 2 })
    if (change === 'workspace')
      Reflect.set(approved, 'workspace', path.join(process.cwd(), 'other'))
    if (change === 'temp')
      Reflect.set(approved, 'sessionTempRoot', process.cwd())
    const result = await new ToolExecutor(registry).execute(
      approved,
      {
        sessionId: 's' as SessionId,
        runId: 'r' as RunId,
        workspace: { canonicalPath: process.cwd() },
      },
      new AbortController().signal,
    )
    if (change === 'unchanged') {
      expect(result).toMatchObject({ status: 'ok' })
      expect(execute).toHaveBeenCalledOnce()
    } else {
      expect(result).toMatchObject({
        status: 'error',
        code: 'RESOURCE_CHANGED',
      })
      expect(execute).not.toHaveBeenCalled()
    }
  })
})
