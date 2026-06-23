import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ToolCall } from './types'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerReadOnlyTools } from './readonly-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import {
  JavaScriptSearcher,
  resolveWorkspaceSearcher,
  __resetCachedSearcher,
  type Searcher,
} from './searcher'

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'))
  await writeFile(path.join(root, 'README.md'), 'hello workspace\n')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'app.ts'), 'const marker = true\n')
  return root
}

async function executeReadonly(
  root: string,
  call: ToolCall,
  searcher?: Searcher,
) {
  const registry = new ToolRegistry()
  registerReadOnlyTools(
    registry,
    undefined,
    searcher ? () => Promise.resolve(searcher) : undefined,
  )
  const executor = new ToolExecutor(registry)
  const context = {
    sessionId: 'session-test' as SessionId,
    runId: 'run-test' as RunId,
    workspace: { canonicalPath: root },
  }
  const signal = new AbortController().signal
  const inspected = executor.inspectCall(call)

  if (!inspected.ok) {
    return inspected.result
  }

  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: root,
    mode: 'readonly',
    call,
    definition: inspected.definition,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
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

  it('terminates catastrophic grep expressions in the JavaScript fallback', async () => {
    const root = await workspace()
    await writeFile(
      path.join(root, 'catastrophic.txt'),
      `${'a'.repeat(80_000)}!`,
    )

    const result = await executeReadonly(
      root,
      {
        id: 'call-grep-timeout' as CallId,
        toolId: 'grep',
        args: { pattern: '(a+)+$', path: '.', maxResults: 10 },
        reason: 'Exercise regex timeout',
      },
      new JavaScriptSearcher(),
    )

    expect(result).toMatchObject({
      status: 'error',
      code: 'REGEX_TIMEOUT',
    })
  })

  it('returns relative paths and line numbers from the ripgrep backend', async () => {
    __resetCachedSearcher()
    const searcher = await resolveWorkspaceSearcher()
    const root = await workspace()
    await writeFile(
      path.join(root, 'src', 'util.ts'),
      'export const marker = 1\n',
    )

    const result = await executeReadonly(
      root,
      {
        id: 'call-grep-rg' as CallId,
        toolId: 'grep',
        args: { pattern: 'marker', include: '**/*.ts', maxResults: 10 },
        reason: '',
      },
      searcher,
    )

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as {
        matches: Array<{ path: string; line: number; text: string }>
      }
      const paths = content.matches.map((match) => match.path)
      expect(paths).toContain('src/app.ts')
      expect(paths).toContain('src/util.ts')
      const appMatch = content.matches.find(
        (match) => match.path === 'src/app.ts',
      )
      expect(appMatch?.line).toBe(1)
      expect(appMatch?.text).toContain('marker')
    }
  })

  it('prefixes read_file content with line numbers by default', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'lines.txt'), 'alpha\nbeta\ngamma\n')

    const result = await executeReadonly(root, {
      id: 'call-read-numbers' as CallId,
      toolId: 'read_file',
      args: { path: 'lines.txt' },
      reason: '',
    })

    expect(result).toMatchObject({
      status: 'ok',
      content: { startLine: 1, endLine: 3, truncated: false },
    })

    if (result.status === 'ok') {
      const content = result.content as { content: string }
      expect(content.content).toBe('1\talpha\n2\tbeta\n3\tgamma')
    }
  })

  it('omits line numbers when lineNumbers is false', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'lines.txt'), 'alpha\nbeta\n')

    const result = await executeReadonly(root, {
      id: 'call-read-no-numbers' as CallId,
      toolId: 'read_file',
      args: { path: 'lines.txt', lineNumbers: false },
      reason: '',
    })

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as { content: string }
      expect(content.content).toBe('alpha\nbeta')
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

  it('paginates files by line and returns a continuation position', async () => {
    const root = await workspace()
    await writeFile(
      path.join(root, 'large.txt'),
      `${Array.from({ length: 1_200 }, (_, index) => `line-${index + 1}`).join('\n')}\n`,
    )
    const first = await executeReadonly(root, {
      id: 'call-page-1' as CallId,
      toolId: 'read_file',
      args: { path: 'large.txt', startLine: 1, lineCount: 1_000 },
      reason: '',
    })

    expect(first).toMatchObject({
      status: 'ok',
      content: {
        startLine: 1,
        endLine: 1_000,
        nextStartLine: 1_001,
        truncated: true,
      },
    })

    const second = await executeReadonly(root, {
      id: 'call-page-2' as CallId,
      toolId: 'read_file',
      args: { path: 'large.txt', startLine: 1_001, lineCount: 1_000 },
      reason: '',
    })
    expect(second).toMatchObject({
      status: 'ok',
      content: {
        startLine: 1_001,
        truncated: false,
      },
    })
  })

  it('bounds one extremely long line', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'one-line.txt'), 'x'.repeat(100_000))
    const result = await executeReadonly(root, {
      id: 'call-long-line' as CallId,
      toolId: 'read_file',
      args: { path: 'one-line.txt' },
      reason: '',
    })

    expect(result).toMatchObject({
      status: 'ok',
      content: { lineTruncated: true, truncated: true },
    })

    if (result.status === 'ok') {
      const content = result.content as { content: string }
      expect(Buffer.byteLength(content.content, 'utf8')).toBeLessThanOrEqual(
        64 * 1_024,
      )
    }
  })
})
