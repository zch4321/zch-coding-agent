import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ToolCall } from '../tools/types'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from './permission-pipeline'
import { registerReadOnlyTools } from './readonly-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'))
  await writeFile(path.join(root, 'README.md'), 'hello workspace\n')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'app.ts'), 'const marker = true\n')
  return root
}

describe('read-only tools', () => {
  it('executes read_file, list_dir, glob, and grep inside a workspace', async () => {
    const root = await workspace()
    const registry = new ToolRegistry()
    registerReadOnlyTools(registry)
    const executor = new ToolExecutor(registry)
    const context = {
      sessionId: 'session-test' as SessionId,
      runId: 'run-test' as RunId,
      workspace: { canonicalPath: root },
    }
    const signal = new AbortController().signal
    const pipeline = new PermissionPipeline()

    const calls: ToolCall[] = [
      {
        id: 'call-read' as CallId,
        toolId: 'read_file',
        args: { path: 'README.md' },
        reason: '',
      },
      {
        id: 'call-list' as CallId,
        toolId: 'list_dir',
        args: { path: '.', recursive: false },
        reason: '',
      },
      {
        id: 'call-glob' as CallId,
        toolId: 'glob',
        args: { pattern: '**/*.ts' },
        reason: '',
      },
      {
        id: 'call-grep' as CallId,
        toolId: 'grep',
        args: { pattern: 'marker', include: '**/*.ts' },
        reason: '',
      },
    ]

    for (const call of calls) {
      const inspected = executor.inspectCall(call)

      expect(inspected.ok).toBe(true)

      if (inspected.ok) {
        const prepared = await pipeline.authorize({
          ...context,
          workspace: root,
          mode: 'readonly',
          call,
          definition: inspected.definition,
          config: toPublicConfig(DEFAULT_APP_CONFIG, false),
          signal,
          requestHumanApproval: async () => ({ decision: 'deny' }),
        })
        expect(prepared.ok).toBe(true)

        if (!prepared.ok) {
          continue
        }

        const result = await executor.execute(
          prepared.approvedCall,
          context,
          signal,
        )
        expect(result.status).toBe('ok')
      }
    }
  })

  it('returns a structured error for path escapes', async () => {
    const root = await workspace()
    const registry = new ToolRegistry()
    registerReadOnlyTools(registry)
    const executor = new ToolExecutor(registry)
    const call: ToolCall = {
      id: 'call-escape' as CallId,
      toolId: 'read_file',
      args: { path: '../outside.txt' },
      reason: '',
    }
    const inspected = executor.inspectCall(call)

    expect(inspected.ok).toBe(true)

    if (inspected.ok) {
      const prepared = await new PermissionPipeline().authorize({
        sessionId: 'session-test' as SessionId,
        runId: 'run-test' as RunId,
        workspace: root,
        mode: 'readonly',
        call,
        definition: inspected.definition,
        config: toPublicConfig(DEFAULT_APP_CONFIG, false),
        signal: new AbortController().signal,
        requestHumanApproval: async () => ({ decision: 'deny' }),
      })
      expect(prepared).toMatchObject({
        ok: false,
        result: {
          status: 'error',
          code: 'PATH_OUTSIDE_WORKSPACE',
        },
      })
    }
  })
})
