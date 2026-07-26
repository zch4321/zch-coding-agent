import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { BenchmarkAgentCase } from '../../shared/benchmark'
import type {
  LLMProvider,
  ProviderStreamRequest,
  ProviderEvent,
} from '../providers/provider'
import { parseHeadlessArguments } from './cli'
import type { HeadlessBenchmarkController, HeadlessConfig } from './contracts'
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

class EditProvider implements LLMProvider {
  receivedApiKey = ''
  calls = 0

  async *stream(): AsyncIterable<ProviderEvent> {
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

class PlanProvider implements LLMProvider {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === 1) {
      yield toolCompletion(
        'call-plan-set',
        'plan_set',
        { items: ['Finish the benchmark plan'] },
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

class HangingProvider implements LLMProvider {
  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    if (request.signal.aborted) throw request.signal.reason
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
    })
    yield messageCompletion('unreachable', 'unreachable')
  }
}

class RepairProvider implements LLMProvider {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []
  requestBodies: JsonValue[] = []

  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    this.requestBodies.push(structuredClone(request.providerRequest ?? null))
    yield messageCompletion(
      `repair-${this.calls}`,
      this.calls === 1 ? 'Initial attempt complete.' : 'Repair complete.',
    )
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
    schemaVersion: 1,
    provider: {
      id: 'fake',
      baseURL: 'https://provider.invalid',
      model: 'fake-model',
      reasoning: 'off',
      credentialEnv: 'HEADLESS_TEST_KEY',
    },
    assistant: { language: 'en-US' },
    ...overrides,
  }
}

function benchmarkCase(): BenchmarkAgentCase {
  return {
    schemaVersion: 1,
    caseId: 'case-one',
    suiteId: 'core-harness-8',
    suiteRevision: 'smoke-v1',
    task: 'Fix src/example.mjs',
    publicChecks: [
      {
        id: 'public-check',
        title: 'Public behavior',
        acceptanceGroupId: 'behavior',
        command: {
          executable: 'node',
          args: ['test/public.test.mjs'],
          timeoutMs: 5_000,
          maxOutputBytes: 65_536,
        },
      },
    ],
    modificationScope: {
      allowedPaths: ['src/**'],
      deniedPaths: ['test/**'],
      maxChangedFiles: 2,
      maxPatchBytes: 65_536,
    },
    resources: {
      wallTimeMs: 60_000,
      cpus: 1,
      memoryBytes: 536_870_912,
      pids: 64,
      diskBytes: 268_435_456,
      maxAgentSteps: 32,
      maxContextTokens: 65_536,
    },
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
    const benchmarkParsed = parseHeadlessArguments([
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
      '--benchmark-protocol',
      'repair-once',
      '--benchmark-case-file',
      'benchmark-case.json',
    ])
    expect(benchmarkParsed.benchmarkProtocol).toBe('repair-once')
    expect(benchmarkParsed.benchmarkCaseFile).toBe(
      path.resolve('benchmark-case.json'),
    )
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
    const benchmarkCaseFile = path.join(directory, 'benchmark-case.json')
    await Promise.all([
      writeFile(taskFile, 'Create headless-created.txt\n'),
      writeFile(configFile, `${JSON.stringify(config())}\n`),
      writeFile(benchmarkCaseFile, `${JSON.stringify(benchmarkCase())}\n`),
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
        '--benchmark-case-file',
        benchmarkCaseFile,
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
    expect(diagnostics.value).toBe('')
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
      configHash: string
      toolsHash: string
      promptResources: unknown[]
      capabilities: { toolNames: string[] }
    }
    expect(identity.configHash).toBe(result.configHash)
    expect(identity.toolsHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(identity.promptResources.length).toBeGreaterThan(0)
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

  it('injects a public benchmark descriptor separately from the user task', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new RepairProvider()
    const result = await runHeadlessAgent({
      config: config(),
      workspace,
      task: 'Fix the implementation',
      benchmarkCase: benchmarkCase(),
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
    })

    expect(result.status).toBe('completed')
    const messages = provider.requests[0] ?? []
    const descriptorIndex = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        String(message.content ?? '').includes('<benchmark_case') &&
        String(message.content ?? '').includes('"deniedPaths"') &&
        String(message.content ?? '').includes('test/**'),
    )
    const taskIndex = messages.findIndex(
      (message) =>
        message.role === 'user' && message.content === 'Fix the implementation',
    )
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(taskIndex).toBeGreaterThan(descriptorIndex)
    const trace = await readFile(result.artifacts.tracePath, 'utf8')
    expect(trace).toContain('"kind":"benchmark_case"')
    expect(trace).toContain('"type":"user.message"')
    expect(trace).not.toContain(
      '"type":"user.message","text":"{\\n  \\"schemaVersion\\"',
    )
  })

  it('uses the prepared Desktop default reasoning when headless reasoning is omitted', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new RepairProvider()
    const omittedReasoning = config()
    omittedReasoning.provider.profile = 'deepseek'
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

  it('appends one benchmark repair as trusted harness context in the same session', async () => {
    const { workspace, artifacts } = await fixture()
    const output = new StringSink()
    const provider = new RepairProvider()
    const benchmarkController: HeadlessBenchmarkController = {
      protocol: 'repair-once',
      async waitForDecision() {
        return {
          schemaVersion: 1,
          action: 'repair',
          feedback: {
            visibility: 'diagnostic',
            text: 'The edge-case acceptance group is still failing.',
          },
        }
      },
    }
    const result = await runHeadlessAgent({
      config: config(),
      workspace,
      task: 'Attempt the benchmark task',
      artifactsDirectory: artifacts,
      timeoutMs: 5_000,
      output,
      environment: { NODE_ENV: 'test', HEADLESS_TEST_KEY: 'secret' },
      providerFactory: () => provider,
      benchmarkController,
    })

    expect(result.status).toBe('completed')
    expect(result.runIds).toHaveLength(2)
    expect(result.benchmark).toMatchObject({
      protocol: 'repair-once',
      repairAttempted: true,
      initialRunIds: [result.runIds[0]],
      repairRunIds: [result.runIds[1]],
    })
    expect(output.value).toContain('"type":"benchmark.phase_ready"')
    expect(provider.requests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('<benchmark_feedback'),
        }),
      ]),
    )
    const trace = await readFile(result.artifacts.tracePath, 'utf8')
    expect(trace).toContain('"kind":"benchmark_feedback"')
    expect(trace).toContain('"type":"orchestrator.message"')
    expect(trace).not.toContain(
      '"type":"user.message","text":"Visibility: diagnostic',
    )
  }, 20_000)
})
