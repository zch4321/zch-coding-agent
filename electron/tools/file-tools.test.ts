import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ToolCall } from './types'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { registerFileTools } from './file-tools'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { ToolExecutor, ToolRegistry } from './tool-registry'

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

const replacementPatch = [
  '--- a/note.txt',
  '+++ b/note.txt',
  '@@ -1,2 +1,1 @@',
  '-alpha',
  '-beta',
  '+replacement',
].join('\n')

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

  if (!definition) {
    throw new Error('Missing test tool')
  }

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

  if (!approval.ok) {
    return approval.result
  }

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

describe('P3 file tools', () => {
  it('atomically writes, patches, and deletes workspace files', async () => {
    const root = await workspace()

    await expect(
      execute(root, {
        id: 'call:write' as CallId,
        toolId: 'write_file',
        args: { path: 'created.txt', content: 'created\n' },
        reason: 'Create a fixture',
      }),
    ).resolves.toMatchObject({ status: 'ok' })
    expect(await readFile(path.join(root, 'created.txt'), 'utf8')).toBe(
      'created\n',
    )

    await expect(
      execute(root, {
        id: 'call:patch' as CallId,
        toolId: 'apply_patch',
        args: { path: 'note.txt', patch: betaToGammaPatch() },
        reason: 'Update one line',
      }),
    ).resolves.toMatchObject({ status: 'ok' })
    expect(await readFile(path.join(root, 'note.txt'), 'utf8')).toBe(
      'alpha\ngamma\n',
    )

    await expect(
      execute(root, {
        id: 'call:delete' as CallId,
        toolId: 'delete_file',
        args: { path: 'created.txt' },
        reason: 'Remove the fixture',
      }),
    ).resolves.toMatchObject({ status: 'ok' })
    await expect(
      readFile(path.join(root, 'created.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects patch context that does not match without changing the file', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    await writeFile(target, 'same\nsame\n', 'utf8')
    const { approval } = await authorize(root, {
      id: 'call:mismatch' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: betaToGammaPatch() },
      reason: 'Mismatched patch',
    })

    expect(approval).toMatchObject({
      ok: false,
      result: { status: 'error', code: 'INVALID_PATCH' },
    })
    expect(await readFile(target, 'utf8')).toBe('same\nsame\n')
  })

  it('invalidates approval when target content changes before execution', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:toctou' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: betaToGammaPatch() },
      reason: 'Update one line',
    }
    const { approval, executor } = await authorize(root, call)

    expect(approval.ok).toBe(true)
    await writeFile(target, 'changed elsewhere\n', 'utf8')

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        status: 'error',
        code: 'RESOURCE_CHANGED',
      })
    }

    expect(await readFile(target, 'utf8')).toBe('changed elsewhere\n')
  })

  it('invalidates approval when the target is replaced with identical content', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:replacement' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: replacementPatch },
      reason: 'Replace the file',
    }
    const { approval, executor } = await authorize(root, call)
    await rename(target, path.join(root, 'old-note.txt'))
    await writeFile(target, 'alpha\nbeta\n', 'utf8')

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    }
  })

  it('invalidates approval when an existing target is deleted', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:deleted' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: replacementPatch },
      reason: 'Replace the file',
    }
    const { approval, executor } = await authorize(root, call)
    await rename(target, path.join(root, 'removed-note.txt'))

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    }
  })

  it('invalidates approval when a previously missing target is created', async () => {
    const root = await workspace()
    const target = path.join(root, 'new-note.txt')
    const call: ToolCall = {
      id: 'call:created' as CallId,
      toolId: 'write_file',
      args: { path: 'new-note.txt', content: 'agent content\n' },
      reason: 'Create a file',
    }
    const { approval, executor } = await authorize(root, call)
    await writeFile(target, 'created elsewhere\n', 'utf8')

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    }
    expect(await readFile(target, 'utf8')).toBe('created elsewhere\n')
  })

  it('invalidates approval when the target parent directory is replaced', async () => {
    const root = await workspace()
    const directory = path.join(root, 'src')
    await mkdir(directory)
    await writeFile(path.join(directory, 'note.txt'), 'alpha\nbeta\n')
    const call: ToolCall = {
      id: 'call:parent' as CallId,
      toolId: 'apply_patch',
      args: {
        path: 'src/note.txt',
        patch: betaToGammaPatch('src/note.txt'),
      },
      reason: 'Update nested file',
    }
    const { approval, executor } = await authorize(root, call)
    await rename(directory, path.join(root, 'src-old'))
    await mkdir(directory)
    await writeFile(path.join(directory, 'note.txt'), 'alpha\nbeta\n')

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    }
  })

  it('leaves the original file and no temp file when already cancelled', async () => {
    const root = await workspace()
    const target = path.join(root, 'note.txt')
    const call: ToolCall = {
      id: 'call:cancelled' as CallId,
      toolId: 'apply_patch',
      args: { path: 'note.txt', patch: replacementPatch },
      reason: 'Replace the file',
    }
    const { approval, executor } = await authorize(root, call)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    if (approval.ok) {
      await expect(
        executor.execute(
          approval.approvedCall,
          {
            sessionId,
            runId,
            workspace: { canonicalPath: root },
          },
          controller.signal,
        ),
      ).resolves.toMatchObject({ status: 'cancelled' })
    }

    expect(await readFile(target, 'utf8')).toBe('alpha\nbeta\n')
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    )
  })
})
