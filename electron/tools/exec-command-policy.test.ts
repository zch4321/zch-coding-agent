import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import type {
  ApprovalRequest,
  HumanApprovalDecision,
} from '../permission/permission-pipeline'
import {
  commandInput,
  commandOwner,
  controlledCommands,
} from '../process/command-session-test-support'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import { registerProcessTools } from './process-tools'
import { execCommandInput, type ExecCommandArgs } from './exec-command-schema'
import { formatExecCommandResult } from './exec-command-result'

const fixtures: ReturnType<typeof controlledCommands>[] = []
async function fixture() {
  const value = controlledCommands()
  fixtures.push(value)
  const owner = commandOwner()
  const signal = new AbortController().signal
  value.manager.beginRun(owner, signal)
  const id = await value.manager.start(
    owner,
    commandInput({ launch: { executable: 'node', args: ['script.js'] } }),
  )
  const config = toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
  const registry = new ToolRegistry()
  registerProcessTools(registry, () => config, value.manager)
  const executor = new ToolExecutor(registry)
  const human = vi.fn<
    (request: ApprovalRequest) => Promise<HumanApprovalDecision>
  >(async () => ({ decision: 'allow' }))
  const authorize = async (args: ExecCommandArgs) => {
    const call = {
      id: 'call:policy' as CallId,
      toolId: 'exec_command',
      args: JSON.parse(JSON.stringify(args)),
      reason: 'test exec action',
    }
    const inspected = executor.inspectCall(call)
    if (!inspected.ok) throw Error('Invalid test call')
    return new PermissionPipeline().authorize({
      ...owner,
      workspace: process.cwd(),
      mode: 'auto',
      call,
      definition: inspected.definition,
      config,
      signal,
      requestHumanApproval: human,
    })
  }
  return {
    ...value,
    id,
    owner,
    signal,
    config,
    executor,
    registry,
    human,
    authorize,
  }
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    value.children.forEach((child) => child.close())
    await value.manager.dispose()
  }
})

describe('exec call policy and projection', () => {
  it('allows polling/stopping without approval and blocks cross-Run handles before approval', async () => {
    const { id, human, authorize } = await fixture()
    expect(await authorize({ sessionId: id })).toMatchObject({ ok: true })
    expect(await authorize({ sessionId: id, chars: '' })).toMatchObject({
      ok: true,
    })
    expect(await authorize({ sessionId: id, terminate: true })).toMatchObject({
      ok: true,
    })
    expect(
      await authorize({ sessionId: 'exec:foreign', chars: 'y' }),
    ).toMatchObject({ ok: false, result: { code: 'EXEC_SESSION_NOT_FOUND' } })
    expect(human).not.toHaveBeenCalled()
  })

  it('never reuses a broad launch approval for stdin or EOF and includes launch context', async () => {
    const { id, human, authorize, config } = await fixture()
    config.permission.rememberedRules.push({
      id: 'rule:launch',
      effect: 'allow',
      toolId: 'exec_command',
      workspaceScope: '*',
      argConstraints: null,
      createdFromCallId: 'call:launch' as CallId,
    })
    await authorize({ sessionId: id, command: 'y' })
    await authorize({ sessionId: id, closeStdin: true })
    expect(human).toHaveBeenCalledTimes(2)
    expect(human.mock.calls[0]?.[0]).toMatchObject({
      rememberable: false,
      policySignals: expect.arrayContaining([
        expect.objectContaining({
          code: 'exec_stdin_write',
          detail: expect.stringContaining('script.js'),
        }),
      ]),
    })
  })

  it('derives scheduling from validated arguments and keeps the default definition write-capable', async () => {
    const { id, executor, registry } = await fixture()
    for (const [args, mode] of [
      [{ command: 'echo test' }, 'parallel'],
      [{ sessionId: id }, 'parallel'],
      [{ sessionId: id, command: 'y' }, 'serial'],
      [{ sessionId: id, closeStdin: true }, 'serial'],
    ] as const) {
      const result = executor.inspectCall({
        id: 'call:traits' as CallId,
        toolId: 'exec_command',
        args,
        reason: 'traits',
      })
      expect(result.ok && result.definition.executionMode).toBe(mode)
    }
    expect(registry.get('exec_command')?.effects).toContain('process.spawn')
    expect(registry.get('run_command')).toBeUndefined()
    expect(
      executor.inspectCall({
        id: 'call:old' as CallId,
        toolId: 'run_command',
        args: {},
        reason: 'old call',
      }),
    ).toMatchObject({
      ok: false,
      result: { message: expect.stringContaining('replaced by exec_command') },
    })
  })

  it('preserves the exact command/chars newline contract', () => {
    expect(execCommandInput({ command: 'y' })).toBe('y\n')
    expect(execCommandInput({ command: 'y\r\n' })).toBe('y\r\n')
    expect(execCommandInput({ command: 'a\nb' })).toBe('a\nb\n')
    expect(execCommandInput({ chars: '\u0003' })).toBe('\u0003')
    expect(execCommandInput({ chars: '' })).toBe('')
  })

  it('retains session metadata when source bytes or lines exceed the model budget', () => {
    const result = formatExecCommandResult(
      {
        sessionId: 'exec:test',
        state: 'running',
        stdout: '中文\n'.repeat(5000),
        stderr: 'error',
        stdinClosed: false,
        exitCode: null,
        exitSignal: null,
        truncated: false,
        totalBytes: 100000,
        artifactAvailable: true,
        artifactPath: '/project/commands/1',
      },
      { maxToolOutputBytes: 1024, maxToolOutputLines: 3 },
    )
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024)
    expect(result.text.split('\n').length).toBeLessThanOrEqual(3)
    expect(JSON.parse(result.text.split('\n')[0]!)).toMatchObject({
      sessionId: 'exec:test',
      state: 'running',
      truncated: true,
      artifactPath: '/project/commands/1',
    })
    expect(result.text).not.toContain('\ufffd')
  })
})
