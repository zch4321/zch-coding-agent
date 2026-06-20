import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ToolCall } from '../tools/types'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import type { AutoApprover } from './auto-approver'
import { registerFileTools } from './file-tools'
import { PermissionPipeline } from './permission-pipeline'
import { ToolRegistry } from './tool-registry'

const sessionId = 'session:pipeline' as SessionId
const runId = 'run:pipeline' as RunId

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-pipeline-'))
  await writeFile(path.join(root, 'note.txt'), 'before\n')
  return root
}

function fixture(call: ToolCall) {
  const registry = new ToolRegistry()
  registerFileTools(registry)
  const definition = registry.get(call.toolId)

  if (!definition) {
    throw new Error('Missing fixture definition')
  }

  return { definition, pipeline: new PermissionPipeline() }
}

describe('P3 permission pipeline ordering', () => {
  it('rejects invalid workspace calls before invoking beforeToolCall', async () => {
    const root = await workspace()
    const call: ToolCall = {
      id: 'call:escape' as CallId,
      toolId: 'write_file',
      args: { path: '../outside.txt', content: 'bad' },
      reason: 'Escape workspace',
    }
    const { definition, pipeline } = fixture(call)
    const beforeToolCall = vi.fn(async () => ({
      allow: true,
      risk: 'unchanged' as const,
      diagnostics: [],
    }))

    const result = await pipeline.authorize({
      sessionId,
      runId,
      workspace: root,
      mode: 'yolo',
      call,
      definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal: new AbortController().signal,
      beforeToolCall,
      requestHumanApproval: async () => ({ decision: 'allow' }),
    })

    expect(result).toMatchObject({
      ok: false,
      result: { status: 'error', code: 'PATH_OUTSIDE_WORKSPACE' },
    })
    expect(beforeToolCall).not.toHaveBeenCalled()
  })

  it('routes hook-raised high risk to human without calling Auto approver', async () => {
    const root = await workspace()
    const call: ToolCall = {
      id: 'call:risk' as CallId,
      toolId: 'write_file',
      args: { path: 'created.txt', content: 'after\n' },
      reason: 'Create note',
    }
    const { definition, pipeline } = fixture(call)
    const autoApprover: AutoApprover = {
      evaluate: vi.fn(async () => ({
        decision: 'safe' as const,
        note: 'safe',
        valid: true,
      })),
    }
    const requestHumanApproval = vi.fn(async () => ({
      decision: 'deny' as const,
    }))
    const result = await pipeline.authorize({
      sessionId,
      runId,
      workspace: root,
      mode: 'auto',
      call,
      definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal: new AbortController().signal,
      autoApprover,
      beforeToolCall: async () => ({
        allow: true,
        risk: 'high',
        diagnostics: [],
      }),
      requestHumanApproval,
    })

    expect(result.ok).toBe(false)
    expect(autoApprover.evaluate).not.toHaveBeenCalled()
    expect(requestHumanApproval).toHaveBeenCalledOnce()
  })

  it('honors an explicit security hook block in Yolo mode', async () => {
    const root = await workspace()
    const call: ToolCall = {
      id: 'call:block' as CallId,
      toolId: 'write_file',
      args: { path: 'created.txt', content: 'after\n' },
      reason: 'Create note',
    }
    const { definition, pipeline } = fixture(call)
    const result = await pipeline.authorize({
      sessionId,
      runId,
      workspace: root,
      mode: 'yolo',
      call,
      definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal: new AbortController().signal,
      beforeToolCall: async () => ({
        allow: false,
        risk: 'unchanged',
        reason: 'blocked by security hook',
        diagnostics: [],
      }),
      requestHumanApproval: async () => ({ decision: 'allow' }),
    })

    expect(result).toMatchObject({
      ok: false,
      result: { status: 'denied', message: 'blocked by security hook' },
    })
  })
})
