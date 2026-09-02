import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerFileTools } from './file-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import type { ToolCall } from './types'

const sessionId = 'session:file-tools' as SessionId
const runId = 'run:file-tools' as RunId

function betaToGammaPatch(filePath = 'note.txt'): string {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1,2 +1,2 @@',
    ' alpha',
    '-beta',
    '+gamma',
  ].join('\n')
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-file-tools-'))
  await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\n', 'utf8')
  return root
}

function harness() {
  const registry = new ToolRegistry()
  registerFileTools(registry)
  return {
    registry,
    executor: new ToolExecutor(registry),
    pipeline: new PermissionPipeline(),
  }
}

async function authorize(
  root: string,
  call: ToolCall,
  signal = new AbortController().signal,
) {
  const { registry, executor, pipeline } = harness()
  const definition = registry.get(call.toolId)
  if (!definition) throw new Error('Missing test tool')
  const approval = await pipeline.authorize({
    sessionId,
    runId,
    workspace: root,
    mode: 'yolo',
    call,
    definition,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })
  return { approval, executor }
}

async function execute(root: string, call: ToolCall) {
  const { approval, executor } = await authorize(root, call)
  expect(approval.ok).toBe(true)
  if (!approval.ok) return approval.result
  return executor.execute(
    approval.approvedCall,
    {
      sessionId,
      runId,
      workspace: { canonicalPath: root },
    },
    new AbortController().signal,
  )
}

describe('file mutation tools', () => {
  it('allows scratch mutations but blocks application-owned artifacts', async () => {
    const root = await workspace()
    const sessionRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-file-session-'),
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
    const { registry, executor, pipeline } = harness()
    const scratchPath = path.join(sessionTemp.scratch, 'notes.md')
    const call: ToolCall = {
      id: 'call:scratch-write' as CallId,
      toolId: 'write_file',
      args: { path: scratchPath, content: 'temporary notes\n' },
      reason: 'Record temporary notes',
    }
    const definition = registry.get(call.toolId)!
    const approval = await pipeline.authorize({
      sessionId,
      runId,
      workspace: root,
      sessionTemp,
      mode: 'confirm',
      call,
      definition,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal: new AbortController().signal,
      requestHumanApproval: async () => {
        throw new Error('Scratch writes must not request approval')
      },
    })
    expect(approval).toMatchObject({ ok: true })
    if (approval.ok) {
      await executor.execute(
        approval.approvedCall,
        {
          sessionId,
          runId,
          workspace: { canonicalPath: root },
          sessionTemp,
        },
        new AbortController().signal,
      )
    }
    expect(await readFile(scratchPath, 'utf8')).toBe('temporary notes\n')

    await expect(
      pipeline.authorize({
        sessionId,
        runId,
        workspace: root,
        sessionTemp,
        mode: 'yolo',
        call: {
          ...call,
          id: 'call:artifact-write' as CallId,
          args: {
            path: path.join(sessionTemp.artifacts, 'forbidden.txt'),
            content: 'no',
          },
        },
        definition,
        config: toPublicConfig(DEFAULT_APP_CONFIG, false),
        signal: new AbortController().signal,
        requestHumanApproval: async () => ({ decision: 'deny' }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      result: { status: 'error', code: 'PATH_OUTSIDE_WORKSPACE' },
    })
  })

  it('writes, overwrites, patches, and preserves an existing mode', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    await chmod(target, 0o744)

    await expect(
      execute(root, {
        id: 'call:overwrite' as CallId,
        toolId: 'write_file',
        args: { path: 'note.txt', content: 'alpha\nbeta\n' },
        reason: 'Replace a fixture',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      content: { created: false },
    })
    expect((await stat(target)).mode & 0o777).toBe(0o744)

    await expect(
      execute(root, {
        id: 'call:patch' as CallId,
        toolId: 'apply_patch',
        args: { path: 'note.txt', patch: betaToGammaPatch() },
        reason: 'Update one line',
      }),
    ).resolves.toMatchObject({ status: 'ok' })
    expect(await readFile(target, 'utf8')).toBe('alpha\ngamma\n')
  })

  it('creates missing parent directories', async () => {
    const root = await workspace()
    await expect(
      execute(root, {
        id: 'call:nested-write' as CallId,
        toolId: 'write_file',
        args: {
          path: 'src/generated/client.ts',
          content: 'export const generated = true\n',
        },
        reason: 'Create a generated source file',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      content: { created: true },
    })
  })

  it('uses latest content after approval and applies one exact match', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:latest-content' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: betaToGammaPatch() },
      reason: 'Update one line',
    }
    const { approval, executor } = await authorize(root, call)
    await writeFile(target, 'prefix\nalpha\nbeta\nsuffix\n', 'utf8')
    expect(approval.ok).toBe(true)
    if (!approval.ok) return
    await expect(
      executor.execute(
        approval.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: root } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'ok' })
    expect(await readFile(target, 'utf8')).toBe(
      'prefix\nalpha\ngamma\nsuffix\n',
    )
  })

  it('rejects context that becomes ambiguous after approval without writing', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:ambiguous' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: betaToGammaPatch() },
      reason: 'Update one line',
    }
    const { approval, executor } = await authorize(root, call)
    const ambiguous = 'alpha\nbeta\nseparator\nalpha\nbeta\n'
    await writeFile(target, ambiguous, 'utf8')
    expect(approval.ok).toBe(true)
    if (!approval.ok) return
    await expect(
      executor.execute(
        approval.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: root } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'error', code: 'INVALID_PATCH' })
    expect(await readFile(target, 'utf8')).toBe(ambiguous)
  })

  it('lets an approved write replace a file created by another writer', async () => {
    const root = await workspace()
    const target = path.join(root, 'new-note.txt')
    const call: ToolCall = {
      id: 'call:last-writer' as CallId,
      toolId: 'write_file',
      args: { path: 'new-note.txt', content: 'agent content\n' },
      reason: 'Write a file',
    }
    const { approval, executor } = await authorize(root, call)
    await writeFile(target, 'created elsewhere\n', 'utf8')
    expect(approval.ok).toBe(true)
    if (!approval.ok) return
    await expect(
      executor.execute(
        approval.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: root } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'ok', content: { created: false } })
    expect(await readFile(target, 'utf8')).toBe('agent content\n')
  })

  it('rejects an approved call when its workspace scope changes', async () => {
    const root = await workspace()
    const otherRoot = await workspace()
    const call: ToolCall = {
      id: 'call:scope-change' as CallId,
      toolId: 'write_file',
      args: { path: 'scoped.txt', content: 'approved content\n' },
      reason: 'Write in the approved workspace',
    }
    const { approval, executor } = await authorize(root, call)
    expect(approval.ok).toBe(true)
    if (!approval.ok) return

    await expect(
      executor.execute(
        approval.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: otherRoot } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    await expect(
      readFile(path.join(otherRoot, 'scoped.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes large binary files and treats a repeated delete as success', async () => {
    const root = await workspace()
    const target = path.join(root, 'large.bin')
    await writeFile(target, Buffer.from([0, 1, 2, 3]))
    await truncate(target, 100_000_000)

    const first = await execute(root, {
      id: 'call:delete-large' as CallId,
      toolId: 'delete_file',
      args: { path: 'large.bin' },
      reason: 'Delete a binary fixture',
    })
    expect(first).toMatchObject({
      status: 'ok',
      content: { deleted: true },
    })
    const second = await execute(root, {
      id: 'call:delete-again' as CallId,
      toolId: 'delete_file',
      args: { path: 'large.bin' },
      reason: 'Ensure the fixture is absent',
    })
    expect(second).toMatchObject({
      status: 'ok',
      content: { deleted: false },
    })
  })

  it('does not write when execution is already cancelled', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:cancelled' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: betaToGammaPatch() },
      reason: 'Update the file',
    }
    const { approval, executor } = await authorize(root, call)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(approval.ok).toBe(true)
    if (!approval.ok) return
    await expect(
      executor.execute(
        approval.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: root } },
        controller.signal,
      ),
    ).resolves.toMatchObject({ status: 'cancelled' })
    expect(await readFile(target, 'utf8')).toBe('alpha\nbeta\n')
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    )
  })
})
