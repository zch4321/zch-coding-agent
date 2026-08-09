import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderType } from '../../shared/config'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import { parseHeadlessArguments } from './cli'
import { loadHeadlessConfig, prepareHeadlessConfig } from './config'
import type { HeadlessConfig } from './contracts'
import { HEADLESS_EXIT_CODES, runHeadlessMain } from './main'
import { runHeadlessAgent } from './runner'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

class StringSink extends Writable {
  value = ''

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString()
    callback()
  }
}

class EditProvider extends ScriptedProviderHarness {
  receivedApiKey = ''
  calls = 0

  constructor(providerType: ProviderType = 'generic.chat-completions') {
    super(providerType)
  }

  async *run(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls > 1) {
      yield messageCompletion('edit-final', 'Created the requested file.')
      return
    }
    const args = { path: 'headless-created.txt', content: 'from headless\n' }
    const toolCall = {
      id: 'call-create' as CallId,
      toolId: 'create_file',
      args,
      reason: 'Create the requested file',
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'edit-complete' },
      turn: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.toolId,
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
      toolCalls: [toolCall],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
      },
      providerState: {},
      timing: {},
    }
  }
}

class PlanProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  constructor(providerType: ProviderType = 'generic.chat-completions') {
    super(providerType)
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === 1) {
      yield toolCompletion(
        'call-plan-set',
        'plan_set',
        { items: ['Finish the headless plan'] },
        'Create a plan',
      )
      return
    }
    if (this.calls === 2) {
      yield messageCompletion('plan-review-stop', 'Plan ready for review.')
      return
    }
    if (this.calls > 3) {
      yield messageCompletion('plan-final', 'Approved plan completed.')
      return
    }
    yield toolCompletion(
      'call-plan-update',
      'plan_update',
      {
        id: 'item:1',
        status: 'completed',
        result: 'Done',
        evidence: 'Headless continuation executed',
      },
      'Complete the approved plan',
    )
  }
}

class HangingProvider extends ScriptedProviderHarness {
  constructor(providerType: ProviderType = 'generic.chat-completions') {
    super(providerType)
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    if (request.signal.aborted) throw request.signal.reason
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
    })
    yield messageCompletion('unreachable', 'unreachable')
  }
}

class RecordingProvider extends ScriptedProviderHarness {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  requestBodies: JsonValue[] = []

  constructor(providerType: ProviderType = 'generic.chat-completions') {
    super(providerType)
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    this.requestBodies.push(structuredClone(request.providerRequest))
    yield messageCompletion(`recording-${this.calls}`, 'Recorded the request.')
  }
}

function messageCompletion(
  id: string,
  content: string,
): Extract<ProviderEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rawResponse: { id },
    turn: { role: 'assistant', content },
    toolCalls: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    },
    providerState: {},
    timing: {},
  }
}

function toolCompletion(
  callId: string,
  toolId: string,
  args: Record<string, JsonValue>,
  reason: string,
): Extract<ProviderEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rawResponse: { id: callId },
    turn: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: toolId, arguments: JSON.stringify(args) },
        },
      ],
    },
    toolCalls: [{ id: callId as CallId, toolId, args, reason }],
    usage: {},
    providerState: {},
    timing: {},
  }
}

function config(overrides: Partial<HeadlessConfig> = {}): HeadlessConfig {
  return {
    schemaVersion: 4,
    provider: {
      id: 'fake',
      providerType: 'generic.chat-completions',
      baseURL: 'https://provider.invalid',
      model: 'fake-model',
      reasoning: 'off',
      credentialEnv: 'HEADLESS_TEST_KEY',
    },
    assistant: { language: 'en-US' },
    ...overrides,
  }
}

async function fixture(git = false): Promise<{
  directory: string
  workspace: string
  artifacts: string
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-agent-'))
  temporaryDirectories.push(directory)
  const workspace = path.join(directory, 'workspace')
  const artifacts = path.join(directory, 'artifacts')
  await Promise.all([mkdir(workspace), mkdir(artifacts)])
  if (git) {
    await execFileAsync('git', ['init'], { cwd: workspace })
    await writeFile(path.join(workspace, 'baseline.txt'), 'baseline\n')
    await execFileAsync('git', ['add', '.'], { cwd: workspace })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Headless Test',
        '-c',
        'user.email=headless@example.invalid',
        'commit',
        '-m',
        'baseline',
      ],
      { cwd: workspace },
    )
  }
  return { directory, workspace, artifacts }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Headless host', () => {
  it('loads valid v1 config through the current Provider Type migration', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-v1-'))
    temporaryDirectories.push(directory)
    const configPath = path.join(directory, 'headless.json')
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: {
          id: 'legacy-deepseek',
          label: 'Legacy DeepSeek',
          protocol: 'openai-compatible',
          profile: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          model: 'legacy-model',
          reasoning: 'max',
          credentialEnv: 'LEGACY_KEY',
        },
        maxAutoPlanApprovals: 2,
      }),
      'utf8',
    )

    await expect(loadHeadlessConfig(configPath)).resolves.toEqual({
      schemaVersion: 4,
      provider: {
        id: 'legacy-deepseek',
        label: 'Legacy DeepSeek',
        providerType: 'deepseek.chat-completions',
        baseURL: 'https://api.deepseek.com',
        model: 'legacy-model',
        reasoning: 'max',
        credentialEnv: 'LEGACY_KEY',
      },
      maxAutoPlanApprovals: 2,
    })
  })

  it('loads valid v2 config with disabled default Subagents', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-v2-'))
    temporaryDirectories.push(directory)
    const configPath = path.join(directory, 'headless.json')
    const legacy = {
      schemaVersion: 2,
      provider: config().provider,
      assistant: { language: 'en-US' as const },
    }
    await writeFile(configPath, JSON.stringify(legacy), 'utf8')

    await expect(loadHeadlessConfig(configPath)).resolves.toEqual({
      ...legacy,
      schemaVersion: 4,
    })
  })

  it('migrates v3 config without the retired run-wide Tool Result budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-v3-'))
    temporaryDirectories.push(directory)
    const configPath = path.join(directory, 'headless.json')
    const current = config()
    const legacy = {
      ...current,
      schemaVersion: 3,
      limits: { maxToolResultTokens: 12_000, maxToolTokensPerRun: 36_000 },
    }
    await writeFile(configPath, JSON.stringify(legacy), 'utf8')

    await expect(loadHeadlessConfig(configPath)).resolves.toEqual({
      ...current,
      limits: { maxToolResultTokens: 12_000 },
    })
  })

  it('accepts bounded Subagent settings in v4 config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-v4-'))
    temporaryDirectories.push(directory)
    const configPath = path.join(directory, 'headless.json')
    const source = config({
      subagents: { enabled: true, workerTimeoutMs: 2_700_000 },
    })
    await writeFile(configPath, JSON.stringify(source), 'utf8')

    await expect(loadHeadlessConfig(configPath)).resolves.toEqual(source)
  })

  it('keeps external v4 singular Provider config while building an empty v20 model pool', async () => {
    const { artifacts } = await fixture()
    const prepared = await prepareHeadlessConfig({
      config: config(),
      artifactsDirectory: artifacts,
      environment: {
        NODE_ENV: 'test',
        HEADLESS_TEST_KEY: 'headless-secret',
      },
    })

    expect(prepared.config).toMatchObject({
      schemaVersion: 4,
      provider: { id: 'fake' },
    })
    expect(prepared.configStore.getInternalConfig()).toMatchObject({
      schemaVersion: 20,
      activeProviderId: 'fake',
      modelPool: { entries: [] },
    })
  })

  it('accepts Responses and Anthropic Provider Types in v4 config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'headless-p12-'))
    temporaryDirectories.push(directory)
    const configPath = path.join(directory, 'headless.json')

    for (const providerType of [
      'generic.responses',
      'generic.anthropic',
    ] as const) {
      const source = config({
        provider: {
          ...config().provider,
          providerType,
        },
      })
      await writeFile(configPath, JSON.stringify(source), 'utf8')
      await expect(loadHeadlessConfig(configPath)).resolves.toEqual(source)
    }
  })

  it('parses only the fixed run command surface', () => {
    const parsed = parseHeadlessArguments([
      'run',
      '--workspace',
      '.',
      '--task-file',
      'task.md',
      '--config',
      'headless.json',
      '--artifacts',
      '../artifacts',
      '--timeout-ms',
      '1000',
    ])
    expect(parsed.timeoutMs).toBe(1_000)
    expect(() =>
      parseHeadlessArguments([
        'run',
        '--workspace',
        '.',
        '--api-key',
        'secret',
      ]),
    ).toThrow('Unknown argument')
  })

  it('runs the CLI contract with separate JSONL and diagnostic streams', async () => {
    const { directory, workspace, artifacts } = await fixture()
    const taskFile = path.join(directory, 'task.md')
    const configFile = path.join(directory, 'headless.json')
    await Promise.all([
      writeFile(taskFile, 'Create headless-created.txt\n'),
      writeFile(configFile, `${JSON.stringify(config())}\n`),
    ])
    const output = new StringSink()
    const diagnostics = new StringSink()
    const provider = new EditProvider()
    const exitCode = await runHeadlessMain(
      [
        'run',
        '--workspace',
        workspace,
        '--task-file',
        taskFile,
        '--config',
        configFile,
        '--artifacts',
        artifacts,
        '--timeout-ms',
        '5000',
      ],
      {
        output,
        errorOutput: diagnostics,
        environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
        providerFactory: () => provider,
        manageSignals: false,
      },
    )

    expect(exitCode).toBe(HEADLESS_EXIT_CODES.completed)
    expect(output.value).toContain('"type":"runtime.started"')
    expect(output.value).toContain('"type":"runtime.completed"')
    const diagnosticLines = diagnostics.value.trim().split('\n')
    expect(diagnosticLines.length).toBeGreaterThan(0)
    expect(
      diagnosticLines.every((line) =>
        /^\[headless\] SQLite migration \d+:[a-z0-9_]+ (?:started|completed) \(\d+ms\)$/u.test(
          line,
        ),
      ),
    ).toBe(true)
    expect(diagnostics.value).not.toContain(workspace)
    expect(diagnostics.value).not.toContain(artifacts)
    expect(diagnostics.value).not.toContain('HEADLESS_TEST_KEY')
    expect(diagnostics.value).not.toContain('secret')
    expect(diagnostics.value).not.toMatch(
      /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT)\b/u,
    )
    await expect(
      readFile(path.join(artifacts, 'result.json'), 'utf8'),
    ).resolves.toContain('"status": "completed"')
  }, 20_000)

  it('runs editing tools in fixed Yolo and writes JSONL, result, trace, and patch', async () => {
    const { workspace, artifacts } = await fixture(true)
    const output = new StringSink()
    const provider = new EditProvider()
    const secret = 'headless-secret-sentinel'
    const result = await runHeadlessAgent({
      config: config(),
      workspace,
      task: 'Create headless-created.txt',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: secret },
      providerFactory: ({ apiKey }) => {
        provider.receivedApiKey = apiKey
        return provider
      },
    })

    const events = output.value
      .trim()
      .split(/\r?\n/u)
      .map(
        (line) => JSON.parse(line) as { type: string; [key: string]: unknown },
      )
    expect(result.status, output.value).toBe('completed')
    expect(result.tools).toEqual({ proposed: 1, completed: 1, failed: 0 })
    expect(result.usage).toMatchObject({
      records: 2,
      promptTokens: 24,
      completionTokens: 10,
      totalTokens: 34,
    })
    expect(result.artifacts.patchStatus).toBe('written')
    await expect(
      readFile(path.join(workspace, 'headless-created.txt'), 'utf8'),
    ).resolves.toBe('from headless\n')
    await expect(
      readFile(result.artifacts.resultPath, 'utf8'),
    ).resolves.toContain('"status": "completed"')
    const identity = JSON.parse(
      await readFile(result.artifacts.identityPath, 'utf8'),
    ) as {
      schemaVersion: number
      configHash: string
      toolsHash: string
      promptResources: unknown[]
      budgets: { subagentWorkerTimeoutMs: number }
      capabilities: { toolNames: string[]; subagentsEnabled: boolean }
    }
    expect(identity.schemaVersion).toBe(4)
    expect(identity.configHash).toBe(result.configHash)
    expect(identity.toolsHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(identity.promptResources.length).toBeGreaterThan(0)
    expect(identity.budgets.subagentWorkerTimeoutMs).toBe(1_800_000)
    expect(identity.capabilities.subagentsEnabled).toBe(false)
    expect(identity.capabilities.toolNames).toContain('call_mcp_tool')
    await expect(
      readFile(result.artifacts.tracePath, 'utf8'),
    ).resolves.toContain('"type":"tool.call"')
    await expect(
      readFile(result.artifacts.patchPath!, 'utf8'),
    ).resolves.toContain('headless-created.txt')
    expect(events[0]).toMatchObject({
      type: 'runtime.started',
      permissionMode: 'yolo',
    })
    expect(events.at(-1)).toMatchObject({
      type: 'runtime.completed',
      status: 'completed',
    })
    expect(output.value).not.toContain('approval.requested')
    expect(output.value).not.toContain(secret)
    expect(
      await readFile(path.join(artifacts, 'runtime', 'config.json'), 'utf8'),
    ).not.toContain(secret)
    expect(provider.receivedApiKey).toBe(secret)
  }, 20_000)

  it('uses the prepared Desktop default reasoning when headless reasoning is omitted', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new RecordingProvider('deepseek.chat-completions')
    const omittedReasoning = config()
    omittedReasoning.provider.providerType = 'deepseek.chat-completions'
    delete omittedReasoning.provider.reasoning

    const result = await runHeadlessAgent({
      config: omittedReasoning,
      workspace,
      task: 'Use the configured default reasoning',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
    })

    expect(result.status).toBe('completed')
    expect(provider.requestBodies[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('runs and persists with a new reasoning level end to end', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new RecordingProvider('deepseek.chat-completions')
    const mediumReasoning = config()
    mediumReasoning.provider.providerType = 'deepseek.chat-completions'
    mediumReasoning.provider.reasoning = 'medium'

    const result = await runHeadlessAgent({
      config: mediumReasoning,
      workspace,
      task: 'Run with a new reasoning level',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
    })

    expect(result.status).toBe('completed')
    expect(provider.requestBodies[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
    })
  })

  it('auto-approves a reviewed plan using trusted harness context', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new PlanProvider()
    const result = await runHeadlessAgent({
      config: config(),
      workspace,
      task: 'Make a plan and execute it',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
    })

    expect(result.status, output.value).toBe('completed')
    expect(result.autoPlanApprovals).toBe(1)
    expect(result.runIds).toHaveLength(2)
    expect(output.value).toContain('"action":"plan_approved"')
    expect(
      provider.requests[2]?.some(
        (message) =>
          message.role === 'user' &&
          String(message.content ?? '').includes('<autonomous_plan_approval>'),
      ),
    ).toBe(true)
    const trace = await readFile(result.artifacts.tracePath, 'utf8')
    expect(trace).toContain('"source":"headless:auto-plan-approval"')
    expect(trace).toContain('"type":"orchestrator.message"')
    expect(trace).not.toContain(
      '"type":"user.message","text":"<autonomous_plan_approval>',
    )
  }, 20_000)

  it('returns needs_human_input when automatic plan approval is disabled', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new PlanProvider()
    const result = await runHeadlessAgent({
      config: config({ maxAutoPlanApprovals: 0 }),
      workspace,
      task: 'Only create a plan',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
    })

    expect(result).toMatchObject({
      status: 'needs_human_input',
      incompleteReason: 'plan_approval_limit',
      autoPlanApprovals: 0,
    })
    expect(provider.calls).toBe(2)
  }, 20_000)

  it('interrupts the shared runtime and reports a distinct timeout status', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const result = await runHeadlessAgent({
      config: config(),
      workspace,
      task: 'Wait forever',
      artifactsDirectory: artifacts,
      timeoutMs: 50,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => new HangingProvider(),
    })

    expect(result.status).toBe('timed_out')
    expect(output.value).toContain('"status":"timed_out"')
    await expect(
      readFile(result.artifacts.resultPath, 'utf8'),
    ).resolves.toContain('"status": "timed_out"')
  }, 20_000)
})
