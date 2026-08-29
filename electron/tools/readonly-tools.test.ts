import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises'
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
  sessionTemp?: { root: string; artifacts: string; scratch: string },
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
    ...(sessionTemp ? { sessionTemp } : {}),
  }
  const signal = new AbortController().signal
  const inspected = executor.inspectCall(call)

  if (!inspected.ok) {
    return inspected.result
  }

  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: root,
    ...(sessionTemp ? { sessionTemp } : {}),
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

  it('counts glob matches after traversal and treats patterns as path-relative', async () => {
    const root = await workspace()
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        writeFile(
          path.join(root, `${String(index).padStart(2, '0')}-unrelated.txt`),
          'not a component\n',
        ),
      ),
    )
    await mkdir(path.join(root, 'src', 'components'))
    await writeFile(
      path.join(root, 'src', 'components', 'First.vue'),
      '<template />\n',
    )
    await writeFile(
      path.join(root, 'src', 'components', 'Second.vue'),
      '<template />\n',
    )
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(
      path.join(root, 'node_modules', 'ignored.ts'),
      'export const ignored = true\n',
    )

    const limited = await executeReadonly(root, {
      id: 'call-glob-path-relative' as CallId,
      toolId: 'glob',
      args: {
        pattern: '*.vue',
        path: 'src/components',
        maxResults: 1,
      },
      reason: '',
    })
    expect(limited).toMatchObject({
      status: 'ok',
      truncated: true,
      content: { truncated: true },
    })
    if (limited.status === 'ok') {
      const matches = (limited.content as { matches: string[] }).matches
      expect(matches).toHaveLength(1)
      expect([
        'src/components/First.vue',
        'src/components/Second.vue',
      ]).toContain(matches[0])
    }

    const recursive = await executeReadonly(root, {
      id: 'call-glob-recursive' as CallId,
      toolId: 'glob',
      args: { pattern: '**/*.{ts,vue}', maxResults: 10 },
      reason: '',
    })
    expect(recursive).toMatchObject({ status: 'ok', truncated: false })
    if (recursive.status === 'ok') {
      expect((recursive.content as { matches: string[] }).matches).toEqual([
        'src/app.ts',
        'src/components/First.vue',
        'src/components/Second.vue',
      ])
    }

    const exactLimit = await executeReadonly(root, {
      id: 'call-glob-exact-limit' as CallId,
      toolId: 'glob',
      args: { pattern: '**/*.ts', maxResults: 1 },
      reason: '',
    })
    expect(exactLimit).toMatchObject({ status: 'ok', truncated: false })
    if (exactLimit.status === 'ok') {
      expect((exactLimit.content as { matches: string[] }).matches).toEqual([
        'src/app.ts',
      ])
    }
  })

  it('rejects glob traversal and does not follow directory symlinks', async () => {
    const root = await workspace()
    const outside = await mkdtemp(
      path.join(os.tmpdir(), 'agent-tools-outside-'),
    )
    await writeFile(
      path.join(outside, 'secret.ts'),
      'export const secret = true\n',
    )
    await symlink(
      outside,
      path.join(root, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const safe = await executeReadonly(root, {
      id: 'call-glob-symlink' as CallId,
      toolId: 'glob',
      args: { pattern: '**/*.ts', maxResults: 10 },
      reason: '',
    })
    expect(safe).toMatchObject({ status: 'ok', truncated: false })
    if (safe.status === 'ok') {
      expect((safe.content as { matches: string[] }).matches).toEqual([
        'src/app.ts',
      ])
    }

    const escaped = await executeReadonly(root, {
      id: 'call-glob-escape' as CallId,
      toolId: 'glob',
      args: { pattern: '{..,src}/**/*.ts', maxResults: 10 },
      reason: '',
    })
    expect(escaped).toMatchObject({
      status: 'error',
      code: 'INVALID_GLOB',
    })
  })

  it('keeps JavaScript grep fallback glob semantics complete and path-relative', async () => {
    const root = await workspace()
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        writeFile(
          path.join(root, `${String(index).padStart(3, '0')}-unrelated.txt`),
          'not relevant\n',
        ),
      ),
    )
    await writeFile(
      path.join(root, 'src', 'view.vue'),
      '<script>const marker = true</script>\n',
    )

    const recursive = await executeReadonly(
      root,
      {
        id: 'call-grep-fallback-braces' as CallId,
        toolId: 'grep',
        args: {
          pattern: 'marker',
          include: '**/*.{ts,vue}',
          maxResults: 10,
        },
        reason: '',
      },
      new JavaScriptSearcher(),
    )
    expect(recursive).toMatchObject({ status: 'ok', truncated: false })
    if (recursive.status === 'ok') {
      expect(
        (recursive.content as { matches: Array<{ path: string }> }).matches.map(
          (match) => match.path,
        ),
      ).toEqual(['src/app.ts', 'src/view.vue'])
    }

    const pathRelative = await executeReadonly(
      root,
      {
        id: 'call-grep-fallback-path' as CallId,
        toolId: 'grep',
        args: {
          pattern: 'marker',
          path: 'src',
          include: '*.ts',
          maxResults: 10,
        },
        reason: '',
      },
      new JavaScriptSearcher(),
    )
    expect(pathRelative).toMatchObject({ status: 'ok', truncated: false })
    if (pathRelative.status === 'ok') {
      expect(
        (
          pathRelative.content as { matches: Array<{ path: string }> }
        ).matches.map((match) => match.path),
      ).toEqual(['src/app.ts'])
    }

    const explicitFile = await executeReadonly(
      root,
      {
        id: 'call-grep-fallback-file' as CallId,
        toolId: 'grep',
        args: {
          pattern: 'marker',
          path: 'src/app.ts',
          include: '*.vue',
          maxResults: 1,
        },
        reason: '',
      },
      new JavaScriptSearcher(),
    )
    expect(explicitFile).toMatchObject({ status: 'ok', truncated: false })
    if (explicitFile.status === 'ok') {
      expect(
        (
          explicitFile.content as { matches: Array<{ path: string }> }
        ).matches.map((match) => match.path),
      ).toEqual(['src/app.ts'])
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
      content: { startLine: 1, endLine: 3, hasMore: false },
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

  it('uses the configured line budget only for source file lines', async () => {
    const root = await workspace()
    await writeFile(
      path.join(root, 'many-lines.txt'),
      `${Array.from({ length: 600 }, (_, index) => `line-${index + 1}`).join('\n')}\n`,
    )

    const result = await executeReadonly(root, {
      id: 'call-read-default-lines' as CallId,
      toolId: 'read_file',
      args: { path: 'many-lines.txt' },
      reason: '',
    })

    expect(result).toMatchObject({
      status: 'ok',
      content: { endLine: 500, hasMore: true },
    })
    if (result.status === 'ok') {
      expect(
        (result.content as { content: string }).content.split('\n'),
      ).toHaveLength(500)
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
        endLine: 500,
        hasMore: true,
        nextStartLine: 501,
      },
    })

    const nextStartLine =
      first.status === 'ok' &&
      first.content &&
      typeof first.content === 'object' &&
      !Array.isArray(first.content) &&
      typeof first.content.nextStartLine === 'number'
        ? first.content.nextStartLine
        : 1

    const second = await executeReadonly(root, {
      id: 'call-page-2' as CallId,
      toolId: 'read_file',
      args: { path: 'large.txt', startLine: nextStartLine, lineCount: 1_000 },
      reason: '',
    })
    expect(second).toMatchObject({
      status: 'ok',
      content: {
        startLine: 501,
        hasMore: true,
      },
    })
  })

  it('continues one extremely long Unicode line by character offset', async () => {
    const root = await workspace()
    const source = '🙂漢字'.repeat(40_000)
    await writeFile(path.join(root, 'one-line.txt'), source)
    const first = await executeReadonly(root, {
      id: 'call-long-line' as CallId,
      toolId: 'read_file',
      args: { path: 'one-line.txt', lineNumbers: false },
      reason: '',
    })

    expect(first).toMatchObject({
      status: 'ok',
      content: {
        lineTruncated: true,
        hasMore: true,
        nextStartLine: 1,
        nextStartCharacter: expect.any(Number),
      },
    })

    if (first.status === 'ok') {
      const content = first.content as {
        content: string
        nextStartCharacter: number
      }
      expect(Buffer.byteLength(content.content, 'utf8')).toBeLessThanOrEqual(
        256 * 1_024,
      )
      const second = await executeReadonly(root, {
        id: 'call-long-line-continued' as CallId,
        toolId: 'read_file',
        args: {
          path: 'one-line.txt',
          startLine: 1,
          startCharacter: content.nextStartCharacter,
          lineNumbers: false,
        },
        reason: '',
      })
      expect(second).toMatchObject({
        status: 'ok',
        content: { hasMore: false },
      })
      if (second.status === 'ok') {
        expect(
          content.content + (second.content as { content: string }).content,
        ).toBe(source)
      }
    }
  })

  it('continues an appended UTF-8 Session artifact from its next line', async () => {
    const root = await workspace()
    const sessionRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-read-session-'),
    )
    const sessionTemp = {
      root: sessionRoot,
      artifacts: path.join(sessionRoot, 'artifacts'),
      scratch: path.join(sessionRoot, 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const logPath = path.join(sessionTemp.artifacts, 'activity.log')
    await writeFile(logPath, '第一行\n')
    const first = await executeReadonly(
      root,
      {
        id: 'call-artifact-first' as CallId,
        toolId: 'read_file',
        args: { path: logPath },
        reason: '',
      },
      undefined,
      sessionTemp,
    )
    expect(first).toMatchObject({
      status: 'ok',
      content: { hasMore: false, nextStartLine: 2 },
    })
    const nextStartLine =
      first.status === 'ok' &&
      first.content &&
      typeof first.content === 'object' &&
      !Array.isArray(first.content) &&
      typeof first.content.nextStartLine === 'number'
        ? first.content.nextStartLine
        : 1
    await writeFile(logPath, '第一行\n第二行🙂\n')

    const appended = await executeReadonly(
      root,
      {
        id: 'call-artifact-appended' as CallId,
        toolId: 'read_file',
        args: { path: logPath, startLine: nextStartLine },
        reason: '',
      },
      undefined,
      sessionTemp,
    )
    expect(appended).toMatchObject({ status: 'ok' })
    if (appended.status === 'ok') {
      expect((appended.content as { content: string }).content).toBe(
        '2\t第二行🙂',
      )
    }
  })

  it('continues an appended unterminated line by character offset', async () => {
    const root = await workspace()
    const logPath = path.join(root, 'growing.log')
    await writeFile(logPath, '前缀🙂')
    const first = await executeReadonly(root, {
      id: 'call-growing-first' as CallId,
      toolId: 'read_file',
      args: { path: 'growing.log' },
      reason: '',
    })
    expect(first).toMatchObject({
      status: 'ok',
      content: {
        nextStartLine: 1,
        nextStartCharacter: 3,
        hasMore: false,
      },
    })
    await writeFile(logPath, '前缀🙂追加\n')
    const appended = await executeReadonly(root, {
      id: 'call-growing-appended' as CallId,
      toolId: 'read_file',
      args: { path: 'growing.log', startLine: 1, startCharacter: 3 },
      reason: '',
    })
    expect(appended).toMatchObject({ status: 'ok' })
    if (appended.status === 'ok') {
      expect((appended.content as { content: string }).content).toBe('1\t追加')
    }
  })

  it('reports an explicit error when startCharacter exceeds the line', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'short.txt'), 'short\n')

    await expect(
      executeReadonly(root, {
        id: 'call-invalid-character-offset' as CallId,
        toolId: 'read_file',
        args: { path: 'short.txt', startLine: 1, startCharacter: 100 },
        reason: '',
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'INVALID_POSITION',
    })
  })

  it('supports bounded tail reads', async () => {
    const root = await workspace()
    const sessionRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-read-session-'),
    )
    const sessionTemp = {
      root: sessionRoot,
      artifacts: path.join(sessionRoot, 'artifacts'),
      scratch: path.join(sessionRoot, 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const logPath = path.join(sessionTemp.artifacts, 'terminal.log')
    await writeFile(logPath, 'one\ntwo\nthree\n')
    const tail = await executeReadonly(
      root,
      {
        id: 'call-artifact-tail' as CallId,
        toolId: 'read_file',
        args: { path: logPath, tail: true, lineCount: 2 },
        reason: '',
      },
      undefined,
      sessionTemp,
    )
    expect(tail).toMatchObject({ status: 'ok' })
    if (tail.status === 'ok') {
      expect((tail.content as { content: string }).content).toBe(
        '2\ttwo\n3\tthree',
      )
    }
  })
})
