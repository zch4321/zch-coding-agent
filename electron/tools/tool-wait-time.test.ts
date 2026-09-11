import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { CommandSessionManager } from '../process/command-sessions'
import type { TerminalPool } from '../terminal/pool'
import { clampToolWaitTime } from '../tooling/input-normalizer'
import { registerBackgroundTools } from './background-tools'
import { registerFetchTools } from './fetch-tools'
import { registerProcessTools } from './process-tools'
import { registerTerminalTools } from './terminal-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
const context = {
  sessionId: 'session:wait-tests' as SessionId,
  runId: 'run:wait-tests' as RunId,
  workspace: { canonicalPath: process.cwd() },
  sessionTemp: {
    root: process.cwd(),
    scratch: process.cwd(),
    artifacts: process.cwd(),
  },
}

function fixture() {
  const registry = new ToolRegistry()
  const tasks = {
    wait: vi.fn(async () => ({ complete: true })),
    list: vi.fn(),
    cancel: vi.fn(async () => ({ cancellationRequested: true })),
    cancelSession: vi.fn(),
  }
  const sessions = new CommandSessionManager()
  registerBackgroundTools(registry, tasks)
  registerProcessTools(registry, () => config, sessions)
  registerTerminalTools(registry, {} as TerminalPool)
  registerFetchTools(registry, () => config)
  return { registry, executor: new ToolExecutor(registry), tasks, sessions }
}

const cases: Array<{
  tool: string
  field: string
  maximum: number
  args: JsonObject
}> = [
  {
    tool: 'background_wait',
    field: 'timeoutMs',
    maximum: 300_000,
    args: {
      targets: [
        { type: 'subagent', id: 1 },
        { type: 'swarm', id: 2 },
      ],
    },
  },
  {
    tool: 'background_wait',
    field: 'timeoutMs',
    maximum: 60_000,
    args: {
      targets: [
        { type: 'subagent', id: 1 },
        { type: 'terminal', id: 2 },
      ],
    },
  },
  {
    tool: 'background_cancel',
    field: 'waitMs',
    maximum: 60_000,
    args: { target: { type: 'subagent', id: 1 } },
  },
  {
    tool: 'exec_command',
    field: 'yieldTimeMs',
    maximum: 60_000,
    args: { command: 'node --version' },
  },
  {
    tool: 'exec_command',
    field: 'yieldTimeMs',
    maximum: 60_000,
    args: { sessionId: 'exec:test' },
  },
  {
    tool: 'exec_command',
    field: 'yieldTimeMs',
    maximum: 60_000,
    args: { sessionId: 'exec:test', chars: 'y' },
  },
  {
    tool: 'exec_command',
    field: 'yieldTimeMs',
    maximum: 60_000,
    args: { sessionId: 'exec:test', terminate: true },
  },
  {
    tool: 'terminal_send',
    field: 'delayMs',
    maximum: 60_000,
    args: { terminalId: 1, data: 'y' },
  },
  { tool: 'delay', field: 'durationMs', maximum: 60_000, args: {} },
  {
    tool: 'fetch',
    field: 'timeoutMs',
    maximum: 60_000,
    args: { url: 'https://example.com' },
  },
]

describe('model-supplied tool wait limits', () => {
  it.each(cases)(
    'caps $tool.$field at $maximum before validation',
    ({ tool, field, maximum, args }) => {
      const { registry, executor } = fixture()
      const definition = registry.get(tool)!
      for (const requested of [
        maximum + 1,
        maximum + 0.5,
        Number.MAX_VALUE,
        '900000',
      ]) {
        const raw = {
          id: 'call:long-wait' as CallId,
          toolId: tool,
          args: { ...args, [field]: requested },
          reason: 'Wait for completion',
        }
        const canonical = executor.normalizeCall(raw)
        expect(canonical.args).toEqual({ ...args, [field]: maximum })
        expect(raw.args[field]).toBe(requested)
        expect(executor.normalizeCall(canonical)).toEqual(canonical)
        expect(executor.inspectCall(canonical).ok).toBe(true)
        expect(registry.validateArgs(definition, raw.args)).toEqual({
          ok: true,
          args: canonical.args,
        })
        expect(
          registry.validateCanonicalArgs(definition, canonical.args).ok,
        ).toBe(true)
      }
    },
  )

  it.each(cases)(
    'preserves valid values and rejects invalid $tool.$field types/lower bounds',
    ({ tool, field, maximum, args }) => {
      const { registry } = fixture()
      const definition = registry.get(tool)!
      for (const value of [1_000, maximum]) {
        expect(
          registry.validateArgs(definition, { ...args, [field]: value }),
        ).toEqual({ ok: true, args: { ...args, [field]: value } })
      }
      for (const invalid of [-1, 0.5, 'later', true, null, Infinity, NaN]) {
        expect(
          registry.validateArgs(definition, { ...args, [field]: invalid }).ok,
        ).toBe(false)
      }
      if (tool !== 'delay')
        expect(registry.validateArgs(definition, args)).toEqual({
          ok: true,
          args,
        })
      if (tool !== 'delay' && tool !== 'fetch')
        expect(
          registry.validateArgs(definition, { ...args, [field]: 0 }).ok,
        ).toBe(true)
    },
  )

  it('does not loosen other numeric limits or repair invalid target shapes', () => {
    const { registry } = fixture()
    expect(
      registry.validateArgs(registry.get('fetch')!, {
        url: 'https://example.com',
        maxBytes: 1_000_001,
        timeoutMs: 900_000,
      }).ok,
    ).toBe(false)
    expect(
      registry.validateArgs(registry.get('background_list')!, { limit: 101 })
        .ok,
    ).toBe(false)
    for (const targets of ['terminal', [null], [{ type: 'terminal', id: 0 }]]) {
      expect(
        registry.validateArgs(registry.get('background_wait')!, {
          targets,
          timeoutMs: 900_000,
        }).ok,
      ).toBe(false)
    }
    registry.registerTool({
      id: 'external_wait',
      description: 'A tool without local wait normalization',
      inputSchema: Type.Object({ timeoutMs: Type.Integer({ maximum: 10 }) }),
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      execute: vi.fn(),
    })
    expect(
      registry.validateArgs(registry.get('external_wait')!, { timeoutMs: 11 })
        .ok,
    ).toBe(false)
  })

  it.each([
    ['subagent', 300_000],
    ['terminal', 60_000],
  ] as const)(
    'executes a saturated background wait for %s',
    async (type, maximum) => {
      const { executor, registry, tasks } = fixture()
      const call = executor.normalizeCall({
        id: 'call:background-wait' as CallId,
        toolId: 'background_wait',
        args: { targets: [{ type, id: 1 }], timeoutMs: 900_000 },
        reason: 'Wait',
      })
      const signal = new AbortController().signal
      const authorization = await new PermissionPipeline().authorize({
        ...context,
        workspace: process.cwd(),
        mode: 'readonly',
        config,
        call,
        definition: registry.get(call.toolId)!,
        signal,
        requestHumanApproval: vi.fn(),
      })
      expect(authorization.ok).toBe(true)
      if (!authorization.ok) throw new Error('Expected a permitted wait')
      expect(
        await executor.execute(authorization.approvedCall, context, signal),
      ).toMatchObject({ status: 'ok' })
      expect(tasks.wait).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: maximum }),
      )
    },
  )

  it('passes the saturated exec yield time to the process service', async () => {
    const { executor, registry, sessions } = fixture()
    vi.spyOn(sessions, 'describe').mockReturnValue({
      executable: 'node',
      args: [],
    })
    const read = vi.spyOn(sessions, 'read').mockResolvedValue({
      sessionId: 'exec:test',
      state: 'exited',
      stdout: '',
      stderr: '',
      stdinClosed: true,
      exitCode: 0,
      exitSignal: null,
      truncated: false,
      totalBytes: 0,
      artifactAvailable: false,
    })
    const call = executor.normalizeCall({
      id: 'call:exec-wait' as CallId,
      toolId: 'exec_command',
      args: { sessionId: 'exec:test', yieldTimeMs: 900_000 },
      reason: 'Read command output',
    })
    const inspected = executor.inspectCall(call)
    if (!inspected.ok) throw new Error('Expected a valid call')
    const signal = new AbortController().signal
    const authorization = await new PermissionPipeline().authorize({
      ...context,
      workspace: process.cwd(),
      mode: 'readonly',
      config,
      call,
      definition: inspected.definition,
      signal,
      requestHumanApproval: vi.fn(),
    })
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) throw new Error('Expected a permitted poll')
    expect(
      await executor.execute(authorization.approvedCall, context, signal),
    ).toMatchObject({ status: 'ok' })
    expect(read).toHaveBeenCalledWith(
      { sessionId: context.sessionId, runId: context.runId },
      'exec:test',
      60_000,
      expect.any(AbortSignal),
    )
    expect(
      registry.validateCanonicalArgs(registry.get('exec_command')!, {
        sessionId: 'exec:test',
        yieldTimeMs: 900_000,
      }).ok,
    ).toBe(false)
  })

  it('binds human approval and execution to the same capped value without repairing approved arguments', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async (args: JsonObject) => ({
      status: 'ok' as const,
      content: args,
    }))
    registry.registerTool({
      id: 'reviewed_wait',
      description: 'A reviewed operation with a wait',
      inputSchema: Type.Object({
        waitMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
      }),
      normalizeArgs: (args) => clampToolWaitTime(args, 'waitMs', 60_000),
      effects: ['process.write'],
      defaultRisk: 'review',
      supportsAbort: true,
      defaultTimeoutMs: 65_000,
      execute,
    })
    const executor = new ToolExecutor(registry)
    const signal = new AbortController().signal
    const human = vi.fn(async () => ({ decision: 'allow' as const }))
    const call = executor.normalizeCall({
      id: 'call:reviewed-wait' as CallId,
      toolId: 'reviewed_wait',
      args: { waitMs: '900000' },
      reason: 'Wait after the operation',
    })
    const authorization = await new PermissionPipeline().authorize({
      ...context,
      workspace: process.cwd(),
      mode: 'confirm',
      config,
      call,
      definition: registry.get(call.toolId)!,
      signal,
      requestHumanApproval: human,
    })
    if (!authorization.ok) throw new Error('Expected approval')
    expect(human).toHaveBeenCalledWith(
      expect.objectContaining({
        call: expect.objectContaining({ args: { waitMs: 60_000 } }),
      }),
    )
    expect(
      await executor.execute(authorization.approvedCall, context, signal),
    ).toEqual({ status: 'ok', content: { waitMs: 60_000 } })
    expect(
      await executor.execute(
        { ...authorization.approvedCall, args: { waitMs: 900_000 } },
        context,
        signal,
      ),
    ).toMatchObject({ status: 'error', code: 'INVALID_TOOL_ARGS' })
    expect(
      await executor.execute(
        { ...authorization.approvedCall, args: { waitMs: 1 } },
        context,
        signal,
      ),
    ).toMatchObject({ status: 'error', code: 'RESOURCE_CHANGED' })
    expect(execute).toHaveBeenCalledOnce()
  })
})
