import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerProcessTools } from './process-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import type { ToolExecutionContext } from './types'
import { CommandSessionManager } from '../process/command-sessions'

function harness() {
  const registry = new ToolRegistry()
  registerProcessTools(
    registry,
    () => toPublicConfig(DEFAULT_APP_CONFIG, false),
    new CommandSessionManager(),
  )
  return { registry, executor: new ToolExecutor(registry) }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

describe('exec_command provider schema', () => {
  it('exposes a top-level object schema accepted by DeepSeek', () => {
    const { registry } = harness()
    const definition = registry.get('exec_command')

    expect(definition?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        sessionId: expect.any(Object),
        executable: expect.any(Object),
        args: expect.any(Object),
        command: expect.any(Object),
      },
    })
    expect(definition?.inputSchema).not.toHaveProperty('anyOf')
    expect(definition?.executionMode).toBe('parallel')

    const providerDefinition = registry.providerDefinitions()[0]
    expect(providerDefinition).toMatchObject({
      name: 'exec_command',
      intentParameter: '_agent_intent',
      inputSchema: {
        required: expect.arrayContaining(['_agent_intent']),
        properties: { _agent_intent: expect.any(Object) },
      },
    })
    expect(definition?.inputSchema).not.toHaveProperty(
      'properties._agent_intent',
    )
  })

  it.each([
    {},
    { executable: 'node', command: 'node --version' },
    { sessionId: 'exec:test', executable: 'node' },
    { command: 'node --version', args: ['--version'] },
    { chars: 'y' },
    { sessionId: 'exec:test', command: 'y', chars: 'n' },
    { sessionId: 'exec:test', terminate: true, closeStdin: true },
    { sessionId: 'exec:test', yieldTimeMs: 60001 },
  ])('rejects an invalid mode-specific argument combination: %j', (args) => {
    const { executor } = harness()
    const inspected = executor.inspectCall({
      id: 'call:run-command-schema' as CallId,
      toolId: 'exec_command',
      args: json(args),
      reason: 'test validation',
    })

    expect(inspected.ok).toBe(false)

    if (!inspected.ok) {
      expect(inspected.result).toMatchObject({
        status: 'error',
        code: 'INVALID_TOOL_ARGS',
      })
    }
  })

  it.each([
    { executable: 'node', args: ['--version'] },
    { command: 'node --version' },
    { sessionId: 'exec:test', chars: '', yieldTimeMs: 60000 },
    { sessionId: 'exec:test', closeStdin: true },
    { sessionId: 'exec:test', terminate: true, yieldTimeMs: 0 },
  ])('accepts a valid mode-specific argument combination: %j', (args) => {
    const { executor } = harness()
    expect(
      executor.inspectCall({
        id: 'call:run-command-schema' as CallId,
        toolId: 'exec_command',
        args: json(args),
        reason: 'test validation',
      }).ok,
    ).toBe(true)
  })

  it('executes shell mode through the configured resolved profile', async () => {
    const config = toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
    config.executionEnvironment.commandShell = 'git-bash'
    const resolved = {
      profile: {
        id: 'git-bash',
        kind: 'bash',
        label: 'Git Bash',
        executable: process.execPath,
        source: 'path',
      },
      requested: 'git-bash',
      fallback: false,
      fallbackEncoding: 'utf-8',
    } as const
    const shells = {
      resolve: vi.fn(async () => resolved),
      invocation: vi.fn(() => ({
        executable: process.execPath,
        args: ['-e', "process.stdout.write('configured shell')"],
        environment: {},
      })),
    }
    const registry = new ToolRegistry()
    const sessions = new CommandSessionManager()
    registerProcessTools(registry, () => config, sessions, shells)
    const context: ToolExecutionContext = {
      sessionId: 'session:command-shell' as SessionId,
      runId: 'run:command-shell' as RunId,
      workspace: { canonicalPath: process.cwd() },
      signal: new AbortController().signal,
      approvedCall: {} as ToolExecutionContext['approvedCall'],
    }
    sessions.beginRun(context, context.signal)

    await expect(
      registry
        .get('exec_command')!
        .execute({ command: 'echo ignored' }, context),
    ).resolves.toMatchObject({
      status: 'ok',
      content: {
        stdout: 'configured shell',
        state: 'exited',
      },
    })
    expect(shells.resolve).toHaveBeenCalledWith('git-bash')
    expect(shells.invocation).toHaveBeenCalledWith(resolved, 'echo ignored')
    await sessions.dispose()
  })
})

describe('delay tool', () => {
  it('is registered as a low-risk wait primitive for terminal polling', async () => {
    const { registry, executor } = harness()
    const definition = registry.get('delay')
    const sessionId = 'session:delay' as SessionId
    const runId = 'run:delay' as RunId
    const signal = new AbortController().signal
    const call = {
      id: 'call:delay' as CallId,
      toolId: 'delay',
      args: json({ durationMs: 1 }),
      reason: 'Wait before reading terminal output',
    }

    expect(definition).toMatchObject({
      executionMode: 'parallel',
      defaultRisk: 'low',
      effects: [],
    })
    expect(executor.inspectCall(call).ok).toBe(true)

    const approved = await new PermissionPipeline().authorize({
      sessionId,
      runId,
      workspace: process.cwd(),
      mode: 'readonly',
      call,
      definition: definition!,
      config: toPublicConfig(DEFAULT_APP_CONFIG, false),
      signal,
      requestHumanApproval: async () => ({ decision: 'deny' }),
    })

    expect(approved).toMatchObject({
      ok: true,
      approvedCall: { approvedBy: 'readonly' },
    })
    if (!approved.ok) {
      return
    }

    await expect(
      executor.execute(
        approved.approvedCall,
        { sessionId, runId, workspace: { canonicalPath: process.cwd() } },
        signal,
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      content: { waitedMs: expect.any(Number) },
    })
  })
})
