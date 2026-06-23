import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from './permission-pipeline'
import { registerGitReadOnlyTools } from './git-tools'
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
})
