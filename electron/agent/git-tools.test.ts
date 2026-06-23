import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from './permission-pipeline'
import { registerGitReadOnlyTools, registerGitWriteTools } from './git-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

const execFileAsync = promisify(execFile)

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    },
  }).then(({ stdout }) => stdout)
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-tools-'))
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.name', 'agent'])
  await git(root, ['config', 'user.email', 'agent@example.com'])
  await writeFile(path.join(root, 'README.md'), 'hello\n')
  await git(root, ['add', 'README.md'])
  await git(root, ['commit', '--quiet', '-m', 'initial'])
  await writeFile(path.join(root, 'README.md'), 'hello world\n')
  await writeFile(path.join(root, 'src.txt'), 'new file\n')
  await git(root, ['add', 'src.txt'])
  return root
}

function harness(root: string) {
  const registry = new ToolRegistry()
  registerGitReadOnlyTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
  const executor = new ToolExecutor(registry)
  const context = {
    sessionId: 'session-git' as SessionId,
    runId: 'run-git' as RunId,
    workspace: { canonicalPath: root },
  }
  return { registry, executor, context }
}

async function execute(
  root: string,
  call: { toolId: string; args: JsonValue },
) {
  const { executor, context } = harness(root)
  const signal = new AbortController().signal
  const inspected = executor.inspectCall({
    id: 'call-git' as CallId,
    toolId: call.toolId,
    args: call.args,
    reason: '',
  })

  if (!inspected.ok) {
    return inspected.result
  }

  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: root,
    mode: 'auto',
    call: {
      id: 'call-git' as CallId,
      toolId: call.toolId,
      args: call.args,
      reason: '',
    },
    definition: inspected.definition,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
}

describe('git read-only tools', () => {
  it('registers git_status, git_diff, git_log and git_show as vcs.read low risk', () => {
    const { registry } = harness(os.tmpdir())
    for (const id of ['git_status', 'git_diff', 'git_log', 'git_show']) {
      const definition = registry.get(id)
      expect(definition?.effects).toEqual(['vcs.read'])
      expect(definition?.defaultRisk).toBe('low')
    }
  })

  it('auto-approves vcs.read tools without human review in auto mode', async () => {
    const root = await repo()
    const { executor, context } = harness(root)
    const signal = new AbortController().signal
    const inspected = executor.inspectCall({
      id: 'call-git-status' as CallId,
      toolId: 'git_status',
      args: {},
      reason: '',
    })

    expect(inspected.ok).toBe(true)

    if (!inspected.ok) {
      return
    }

    const prepared = await new PermissionPipeline().authorize({
      ...context,
      workspace: root,
      mode: 'auto',
      call: {
        id: 'call-git-status' as CallId,
        toolId: 'git_status',
        args: {},
        reason: '',
      },
      definition: inspected.definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal,
      requestHumanApproval: async () => ({ decision: 'deny' }),
    })

    expect(prepared.ok).toBe(true)

    if (prepared.ok) {
      expect(prepared.approvedCall.approvedBy).toBe('readonly')
    }
  })

  it('runs git_status and reports the working tree state', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_status',
      args: { flags: ['--short'] },
    })

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as { stdout: string; exitCode: number }
      expect(content.exitCode).toBe(0)
      // README.md is modified but not staged (space + M); src.txt is staged (A).
      expect(content.stdout).toContain(' M README.md')
      expect(content.stdout).toContain('A  src.txt')
    }
  })

  it('runs git_diff with pathspecs and the no-ext-diff flag', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_diff',
      args: { paths: ['README.md'] },
    })

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as { stdout: string }
      expect(content.stdout).toContain('-hello')
      expect(content.stdout).toContain('+hello world')
    }
  })

  it('reports a git failure for an unknown ref', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_show',
      args: { ref: 'no-such-ref' },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'GIT_FAILED',
    })
  })

  it('runs git_log with a limit', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_log',
      args: { flags: ['--oneline'], limit: 5 },
    })

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as { stdout: string; exitCode: number }
      expect(content.exitCode).toBe(0)
      expect(content.stdout).toMatch(/initial/u)
    }
  })

  it('runs git_show for a given ref', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_show',
      args: { ref: 'HEAD' },
    })

    expect(result).toMatchObject({ status: 'ok' })

    if (result.status === 'ok') {
      const content = result.content as { stdout: string }
      expect(content.stdout).toContain('initial')
    }
  })

  it('rejects disallowed flags before invoking git', async () => {
    const root = await repo()
    const result = await execute(root, {
      toolId: 'git_status',
      args: { flags: ['--no-wrap'] },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'INVALID_ARGS',
    })
  })

  it('rejects git_log revision option injection and writes no file', async () => {
    const root = await repo()
    const target = path.join(root, 'injected.txt')
    const result = await execute(root, {
      toolId: 'git_log',
      args: { revision: `--output=${target}`, limit: 1 },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'INVALID_ARGS',
    })
    expect(existsSync(target)).toBe(false)
  })

  it('rejects git_show ref option injection and writes no file', async () => {
    const root = await repo()
    const target = path.join(root, 'injected.txt')
    const result = await execute(root, {
      toolId: 'git_show',
      args: { ref: `--output=${target}` },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'INVALID_ARGS',
    })
    expect(existsSync(target)).toBe(false)
  })
})

function writeHarness(root: string) {
  const registry = new ToolRegistry()
  registerGitReadOnlyTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
  registerGitWriteTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
  const executor = new ToolExecutor(registry)
  const context = {
    sessionId: 'session-git' as SessionId,
    runId: 'run-git' as RunId,
    workspace: { canonicalPath: root },
  }
  return { registry, executor, context }
}

async function executeWrite(
  root: string,
  call: { toolId: string; args: JsonValue },
  options: { mode: 'auto' | 'yolo' } = { mode: 'yolo' },
) {
  const { executor, context } = writeHarness(root)
  const signal = new AbortController().signal
  const inspected = executor.inspectCall({
    id: 'call-git-write' as CallId,
    toolId: call.toolId,
    args: call.args,
    reason: '',
  })

  if (!inspected.ok) {
    return inspected.result
  }

  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: root,
    mode: options.mode,
    call: {
      id: 'call-git-write' as CallId,
      toolId: call.toolId,
      args: call.args,
      reason: '',
    },
    definition: inspected.definition,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'allow' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
}

describe('git write tools', () => {
  it('registers git_add, git_commit and git_restore as side-effecting vcs.write', () => {
    const { registry } = writeHarness(os.tmpdir())
    for (const id of ['git_add', 'git_commit', 'git_restore']) {
      const definition = registry.get(id)
      expect(definition?.effects).toContain('vcs.write')
      expect(definition?.effects).toContain('process.spawn')
      expect(definition?.defaultRisk).toBe('review')
    }
  })

  it('stages paths with git_add and commits them with git_commit', async () => {
    const root = await repo()
    const addResult = await executeWrite(root, {
      toolId: 'git_add',
      args: { paths: ['src.txt'] },
    })
    expect(addResult).toMatchObject({ status: 'ok' })

    const commitResult = await executeWrite(root, {
      toolId: 'git_commit',
      args: { message: 'add src' },
    })
    expect(commitResult).toMatchObject({ status: 'ok' })

    const log = await execute(root, {
      toolId: 'git_log',
      args: { flags: ['--oneline'], limit: 1 },
    })
    if (log.status === 'ok') {
      const content = log.content as { stdout: string }
      expect(content.stdout).toMatch(/add src/u)
    }
  })

  it('rejects a git_add path that looks like a git option', async () => {
    const root = await repo()
    const result = await executeWrite(root, {
      toolId: 'git_add',
      args: { paths: ['-A'] },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'INVALID_ARGS',
    })

    // Nothing should be staged as a side effect.
    const status = await execute(root, {
      toolId: 'git_status',
      args: { flags: ['--short'] },
    })
    if (status.status === 'ok') {
      const content = status.content as { stdout: string }
      expect(content.stdout).not.toMatch(/^A\s+-A/u)
    }
  })

  it('rejects git_add combining all=true with paths', async () => {
    const root = await repo()
    const result = await executeWrite(root, {
      toolId: 'git_add',
      args: { all: true, paths: ['src.txt'] },
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'INVALID_ARGS',
    })
  })

  it('runs git_commit with --no-verify so hooks are skipped', async () => {
    const root = await repo()
    // Install a hook that fails the commit if it runs.
    await writeFile(
      path.join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
    )
    const result = await executeWrite(root, {
      toolId: 'git_commit',
      args: { message: 'no hook' },
    })

    expect(result).toMatchObject({ status: 'ok' })
  })

  it('discards working tree changes with git_restore', async () => {
    const root = await repo()
    // Make a committed clean state first.
    await executeWrite(root, { toolId: 'git_add', args: { all: true } })
    await executeWrite(root, {
      toolId: 'git_commit',
      args: { message: 'base' },
    })
    await writeFile(path.join(root, 'README.md'), 'dirty\n')

    const result = await executeWrite(root, {
      toolId: 'git_restore',
      args: { paths: ['README.md'] },
    })

    expect(result).toMatchObject({ status: 'ok' })

    const status = await execute(root, {
      toolId: 'git_status',
      args: { flags: ['--short'] },
    })
    if (status.status === 'ok') {
      const content = status.content as { stdout: string }
      expect(content.stdout).not.toContain('README.md')
    }
  })

  it('requires human review for git_commit --amend in auto mode', async () => {
    const root = await repo()
    const { executor, context } = writeHarness(root)
    const signal = new AbortController().signal
    const inspected = executor.inspectCall({
      id: 'call-amend' as CallId,
      toolId: 'git_commit',
      args: { message: 'amended', amend: true },
      reason: '',
    })

    expect(inspected.ok).toBe(true)

    if (!inspected.ok) {
      return
    }

    const prepared = await new PermissionPipeline().authorize({
      ...context,
      workspace: root,
      mode: 'auto',
      call: {
        id: 'call-amend' as CallId,
        toolId: 'git_commit',
        args: { message: 'amended', amend: true },
        reason: '',
      },
      definition: inspected.definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal,
      requestHumanApproval: async () => ({ decision: 'deny' }),
    })

    // amend raises a danger signal -> deterministic review, never executed.
    expect(prepared.ok).toBe(false)
  })

  it('requires human review for git_restore (discard) in auto mode', async () => {
    const root = await repo()
    const { executor, context } = writeHarness(root)
    const signal = new AbortController().signal
    const inspected = executor.inspectCall({
      id: 'call-restore' as CallId,
      toolId: 'git_restore',
      args: { paths: ['README.md'] },
      reason: '',
    })

    expect(inspected.ok).toBe(true)

    if (!inspected.ok) {
      return
    }

    const prepared = await new PermissionPipeline().authorize({
      ...context,
      workspace: root,
      mode: 'auto',
      call: {
        id: 'call-restore' as CallId,
        toolId: 'git_restore',
        args: { paths: ['README.md'] },
        reason: '',
      },
      definition: inspected.definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal,
      requestHumanApproval: async () => ({ decision: 'deny' }),
    })

    expect(prepared.ok).toBe(false)
  })
})
