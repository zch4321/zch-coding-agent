import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ToolCall } from '../tools/types'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import type { AutoApprover } from './auto-approver'
import { registerFileTools } from '../tools/file-tools'
import { PermissionPipeline } from './permission-pipeline'
import { registerProcessTools } from '../tools/process-tools'
import { ToolRegistry } from '../tools/tool-registry'

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
  registerProcessTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
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
      toolId: 'create_file',
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
      toolId: 'create_file',
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

  it('auto-allows bounded workspace write and patch file calls without the approval model', async () => {
    const root = await workspace()
    const autoApprover: AutoApprover = {
      evaluate: vi.fn(async () => ({
        decision: 'dangerous' as const,
        note: 'should not be called',
        valid: true,
      })),
    }
    const requestHumanApproval = vi.fn(async () => ({
      decision: 'deny' as const,
    }))

    const calls: ToolCall[] = [
      {
        id: 'call:write-policy' as CallId,
        toolId: 'create_file',
        args: { path: 'created.txt', content: 'after\n' },
        reason: 'Create note',
      },
      {
        id: 'call:patch-policy' as CallId,
        toolId: 'apply_patch',
        args: {
          path: 'note.txt',
          patch: [
            '--- a/note.txt',
            '+++ b/note.txt',
            '@@ -1 +1 @@',
            '-before',
            '+after',
          ].join('\n'),
        },
        reason: 'Patch note',
      },
    ]

    for (const call of calls) {
      const { definition, pipeline } = fixture(call)
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
        requestHumanApproval,
      })

      expect(result).toMatchObject({
        ok: true,
        approvedCall: { approvedBy: 'policy' },
      })
    }

    expect(autoApprover.evaluate).not.toHaveBeenCalled()
    expect(requestHumanApproval).not.toHaveBeenCalled()
  })

  it('keeps VCS metadata file mutations on human review in Auto', async () => {
    const root = await workspace()
    await mkdir(path.join(root, '.git'))
    const call: ToolCall = {
      id: 'call:git-config' as CallId,
      toolId: 'create_file',
      args: {
        path: '.git/config',
        content: '[core]\nrepositoryformatversion = 0\n',
      },
      reason: 'Mutate git metadata',
    }
    const { definition, pipeline } = fixture(call)
    const autoApprover: AutoApprover = {
      evaluate: vi.fn(async () => ({
        decision: 'safe' as const,
        note: 'should not be called',
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
      requestHumanApproval,
    })

    expect(result.ok).toBe(false)
    expect(result.policySignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'vcs_metadata_path' }),
      ]),
    )
    expect(autoApprover.evaluate).not.toHaveBeenCalled()
    expect(requestHumanApproval).toHaveBeenCalledOnce()
  })

  it('honors an explicit security hook block in Yolo mode', async () => {
    const root = await workspace()
    const call: ToolCall = {
      id: 'call:block' as CallId,
      toolId: 'create_file',
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

  it('delegates a bounded shell version query to the Auto approver', async () => {
    const root = await workspace()
    const call: ToolCall = {
      id: 'call:npm-version' as CallId,
      toolId: 'run_command',
      args: { mode: 'shell', command: 'npm --version' },
      reason: 'Check npm version',
    }
    const { definition, pipeline } = fixture(call)
    const autoApprover: AutoApprover = {
      evaluate: vi.fn(async () => ({
        decision: 'safe' as const,
        note: 'Read-only version query',
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
      requestHumanApproval,
    })

    expect(result).toMatchObject({
      ok: true,
      approvedCall: { approvedBy: 'model' },
    })
    expect(autoApprover.evaluate).toHaveBeenCalledOnce()
    expect(requestHumanApproval).not.toHaveBeenCalled()
  })

  it.each(['npm install', 'rm build.log', 'echo hello | findstr hello'])(
    'delegates a non-blacklisted shell command to Auto: %s',
    async (command) => {
      const root = await workspace()
      const call: ToolCall = {
        id: 'call:general-shell' as CallId,
        toolId: 'run_command',
        args: { mode: 'shell', command },
        reason: 'Run a general shell command',
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
        requestHumanApproval,
      })

      expect(result).toMatchObject({
        ok: true,
        approvedCall: { approvedBy: 'model' },
      })
      expect(autoApprover.evaluate).toHaveBeenCalledOnce()
      expect(requestHumanApproval).not.toHaveBeenCalled()
    },
  )

  it.each([
    'rm -rf build',
    'rm -r -f build',
    'Remove-Item build -Recurse -Force',
    'git push origin main',
  ])(
    'keeps a blacklisted command on human review in Auto: %s',
    async (command) => {
      const root = await workspace()
      const call: ToolCall = {
        id: 'call:blacklisted-shell' as CallId,
        toolId: 'run_command',
        args: { mode: 'shell', command },
        reason: 'Run a dangerous shell command',
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

      await pipeline.authorize({
        sessionId,
        runId,
        workspace: root,
        mode: 'auto',
        call,
        definition,
        config: toPublicConfig(DEFAULT_APP_CONFIG, false),
        signal: new AbortController().signal,
        autoApprover,
        requestHumanApproval,
      })

      expect(autoApprover.evaluate).not.toHaveBeenCalled()
      expect(requestHumanApproval).toHaveBeenCalledOnce()
    },
  )
})
