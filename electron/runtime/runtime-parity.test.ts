import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import type { AgentEvent } from '../../shared/agent-events'
import type {
  IpcChannel,
  IpcPayload,
  IpcResult,
} from '../../shared/ipc-contract'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { McpServerConfig } from '../../shared/mcp'
import type { RuntimeIdentity } from '../../shared/runtime-identity'
import { WorkbenchStore } from '../workbench/store'
import { createAppIpcHandlers } from '../ipc/app-handlers'
import { handleIpcInvocation } from '../ipc'
import { launchFingerprint } from '../mcp/mcp-manager'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { collectWorkspacePatch } from '../headless/patch'
import { prepareHeadlessConfig } from '../headless/config'
import type { HeadlessConfig, HeadlessResult } from '../headless/contracts'
import { runHeadlessAgent } from '../headless/runner'
import { createAgentRuntime } from './create-agent-runtime'
import { createElectronRuntimeEventListener } from './electron-runtime-event-sink'
import {
  assertComparableRuntimeIdentities,
  createRuntimeIdentity,
  RuntimeIdentityMismatchError,
  sha256Json,
} from './runtime-identity'
import {
  assertRuntimeHostParity,
  normalizeRuntimeParityCapture,
  type ParityProviderRequest,
  type ParityTraceRequest,
  type RuntimeParityCapture,
  RuntimeParityMismatchError,
} from './runtime-parity'

const execFileAsync = promisify(execFile)
const fixtureMcpServer = path.resolve(
  'electron/mcp/fixtures/fake-mcp-server.mjs',
)
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

class ParityTrajectoryProvider implements LLMProvider {
  calls = 0
  readonly requests: ParityProviderRequest[] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await traceRequest(request, `parity-${this.calls}`)

    if (this.calls === 1) {
      yield toolCompletion('read', 'read_file', { path: 'note.txt' })
    } else if (this.calls === 2) {
      yield toolCompletion('patch', 'apply_patch', {
        path: 'note.txt',
        patch: '@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma',
      })
    } else if (this.calls === 3) {
      yield toolCompletion('command', 'run_command', {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('parity-command\\n')"],
      })
    } else if (this.calls === 4) {
      yield toolCompletion('plan-set', 'plan_set', {
        objective: 'Finish parity plan',
        items: ['Record completion'],
      })
    } else if (this.calls === 5) {
      yield messageCompletion('plan-ready', 'Plan ready for review.')
    } else if (this.calls === 6) {
      yield toolCompletion('plan-update', 'plan_update', {
        id: 'item:1',
        status: 'completed',
        result: 'Recorded',
        evidence: 'Parity trajectory completed',
      })
    } else {
      yield messageCompletion('final', 'Parity trajectory completed.')
    }
  }
}

class CompactParityProvider implements LLMProvider {
  readonly requests: ParityProviderRequest[] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await traceRequest(request, 'compact-parity')
    yield messageCompletion('compact', 'Compact parity summary.')
  }
}

class McpParityProvider implements LLMProvider {
  calls = 0
  readonly requests: ParityProviderRequest[] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await traceRequest(request, `mcp-parity-${this.calls}`)
    if (this.calls === 1) {
      yield toolCompletion('delay', 'delay', { durationMs: 250 })
    } else if (this.calls === 2) {
      yield toolCompletion('mcp-list', 'list_mcp_servers', {})
    } else if (this.calls === 3) {
      yield toolCompletion('mcp-read', 'read_mcp_server', {
        serverId: 'fixture',
        limit: 10,
      })
    } else if (this.calls === 4) {
      yield toolCompletion('mcp-call', 'call_mcp_tool', {
        serverId: 'fixture',
        toolName: 'alpha',
        arguments: { value: 'parity' },
      })
    } else {
      yield messageCompletion('mcp-final', 'MCP parity completed.')
    }
  }
}

function toolCompletion(
  id: string,
  toolId: string,
  args: Record<string, JsonValue>,
): Extract<ProviderEvent, { type: 'completed' }> {
  const callId = `call-${id}` as CallId
  return {
    type: 'completed',
    rawResponse: { id },
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
    toolCalls: [{ id: callId, toolId, args, reason: `Parity ${toolId}` }],
    usage: {},
    providerState: {},
    timing: {},
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
    usage: {},
    providerState: {},
    timing: {},
  }
}

async function traceRequest(
  request: ProviderChatRequest,
  prefixHash: string,
): Promise<void> {
  const normalizedMessages = request.messages as unknown as JsonValue[]
  const providerRequest = {
    model: 'parity-model',
    messages: normalizedMessages,
    tools: request.tools,
  } satisfies JsonValue
  await request.onRequest?.({
    normalizedMessages,
    providerRequest,
    requestBytes: Buffer.byteLength(JSON.stringify(providerRequest)),
    prefixHash,
  })
}

function headlessConfig(mcpServers: McpServerConfig[] = []): HeadlessConfig {
  return {
    schemaVersion: 1,
    provider: {
      id: 'parity',
      label: 'Parity',
      baseURL: 'https://provider.invalid',
      model: 'parity-model',
      reasoning: 'off',
      credentialEnv: 'PARITY_PROVIDER_KEY',
    },
    assistant: { language: 'en-US' },
    mcpServers,
    maxAutoPlanApprovals: 1,
  }
}

function trustedMcpConfig(): McpServerConfig {
  const config: McpServerConfig = {
    id: 'fixture',
    label: 'Fixture',
    description: 'Parity MCP fixture',
    enabled: true,
    scope: 'global',
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureMcpServer],
    startupTimeoutMs: 5_000,
    toolTimeoutMs: 5_000,
  }
  config.launchTrust = {
    fingerprint: launchFingerprint(config),
    trustedAt: '2026-07-11T00:00:00.000Z',
  }
  return config
}

async function fixture(): Promise<{
  directory: string
  workspace: string
  electronArtifacts: string
  headlessArtifacts: string
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-parity-'))
  temporaryDirectories.push(directory)
  const workspace = path.join(directory, 'workspace')
  const electronArtifacts = path.join(directory, 'electron-artifacts')
  const headlessArtifacts = path.join(directory, 'headless-artifacts')
  await Promise.all([
    mkdir(workspace),
    mkdir(electronArtifacts),
    mkdir(headlessArtifacts),
  ])
  await writeFile(path.join(workspace, 'note.txt'), 'alpha\nbeta\n')
  await execFileAsync('git', ['init'], { cwd: workspace })
  await execFileAsync('git', ['add', '.'], { cwd: workspace })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Parity Test',
      '-c',
      'user.email=parity@example.invalid',
      'commit',
      '-m',
      'baseline',
    ],
    { cwd: workspace },
  )
  return { directory, workspace, electronArtifacts, headlessArtifacts }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  )
})

describe('Electron and Headless runtime parity', () => {
  it('matches read, write, command, plan continuation, prompt, tools, and patch semantics', async () => {
    const paths = await fixture()
    const task = 'Exercise the shared parity trajectory.'
    const config = headlessConfig()
    const electronProvider = new ParityTrajectoryProvider()
    const electron = await runElectronHost({
      ...paths,
      task,
      config,
      provider: electronProvider,
      approvePlan: true,
    })
    await writeFile(path.join(paths.workspace, 'note.txt'), 'alpha\nbeta\n')
    const headlessProvider = new ParityTrajectoryProvider()
    const headless = await runHeadlessHost({
      ...paths,
      task,
      config,
      provider: headlessProvider,
    })

    expect(
      electron.capture.events
        .filter((event) => event.type === 'tool.proposed')
        .map((event) => event.tool),
    ).toEqual([
      'read_file',
      'apply_patch',
      'run_command',
      'plan_set',
      'plan_update',
    ])
    expect(
      headless.capture.events.some(
        (event) =>
          event.type === 'plan.updated' && event.plan?.status === 'completed',
      ),
    ).toBe(true)

    assertComparableRuntimeIdentities(electron.identity, headless.identity)
    const normalizedElectron = normalizeRuntimeParityCapture(
      electron.capture,
      paths.workspace,
    )
    const normalizedHeadless = normalizeRuntimeParityCapture(
      headless.capture,
      paths.workspace,
    )
    assertRuntimeHostParity(normalizedElectron, normalizedHeadless)
    const semanticDrift = structuredClone(normalizedHeadless)
    const commandArgs = (
      semanticDrift.tools as Array<{ args: Record<string, JsonValue> }>
    )[2]!.args
    commandArgs.executable = 'different-node'
    expect(() =>
      assertRuntimeHostParity(normalizedElectron, semanticDrift),
    ).toThrow(RuntimeParityMismatchError)
  }, 30_000)

  it('matches compact and generic MCP gateway trajectories', async () => {
    const compactPaths = await fixture()
    const compactConfig = headlessConfig()
    const electronCompact = await runElectronHost({
      ...compactPaths,
      task: '/compact',
      config: compactConfig,
      provider: new CompactParityProvider(),
    })
    const headlessCompact = await runHeadlessHost({
      ...compactPaths,
      task: '/compact',
      config: compactConfig,
      provider: new CompactParityProvider(),
    })
    expect(electronCompact.capture.providerRequests[0]?.tools).toEqual([])
    expect(headlessCompact.capture.providerRequests[0]?.tools).toEqual([])
    assertComparableRuntimeIdentities(
      electronCompact.identity,
      headlessCompact.identity,
    )
    assertRuntimeHostParity(
      normalizeRuntimeParityCapture(
        electronCompact.capture,
        compactPaths.workspace,
      ),
      normalizeRuntimeParityCapture(
        headlessCompact.capture,
        compactPaths.workspace,
      ),
    )

    const mcpPaths = await fixture()
    const mcpConfig = headlessConfig([trustedMcpConfig()])
    const electronMcp = await runElectronHost({
      ...mcpPaths,
      task: 'Call the MCP parity tool.',
      config: mcpConfig,
      provider: new McpParityProvider(),
    })
    const headlessMcp = await runHeadlessHost({
      ...mcpPaths,
      task: 'Call the MCP parity tool.',
      config: mcpConfig,
      provider: new McpParityProvider(),
    })
    expect(
      electronMcp.capture.events
        .filter((event) => event.type === 'tool.proposed')
        .map((event) => event.tool),
    ).toContain('mcp:fixture:alpha')
    expect(
      headlessMcp.capture.events
        .filter((event) => event.type === 'tool.proposed')
        .map((event) => event.tool),
    ).toContain('mcp:fixture:alpha')
    assertComparableRuntimeIdentities(
      electronMcp.identity,
      headlessMcp.identity,
    )
    assertRuntimeHostParity(
      normalizeRuntimeParityCapture(electronMcp.capture, mcpPaths.workspace),
      normalizeRuntimeParityCapture(headlessMcp.capture, mcpPaths.workspace),
    )
  }, 30_000)

  it('rejects comparisons with explicit identity differences', async () => {
    const paths = await fixture()
    const provider = new CompactParityProvider()
    const result = await runHeadlessHost({
      ...paths,
      task: '/compact',
      config: headlessConfig(),
      provider,
    })
    const incompatible = structuredClone(result.identity)
    incompatible.sourceCommit = 'different-commit'
    incompatible.caseDigest = 'f'.repeat(64)
    incompatible.provider.model = 'different-model'

    expect(() =>
      assertComparableRuntimeIdentities(result.identity, incompatible),
    ).toThrow(RuntimeIdentityMismatchError)
    try {
      assertComparableRuntimeIdentities(result.identity, incompatible)
    } catch (error) {
      expect(
        (error as RuntimeIdentityMismatchError).differences.map(
          (item) => item.path,
        ),
      ).toEqual(['caseDigest', 'provider.model', 'sourceCommit'])
    }
  }, 20_000)
})

interface HostRunInput {
  workspace: string
  electronArtifacts: string
  headlessArtifacts: string
  task: string
  config: HeadlessConfig
  provider: LLMProvider & { requests: ParityProviderRequest[] }
  approvePlan?: boolean
}

interface HostRunOutput {
  identity: RuntimeIdentity
  capture: RuntimeParityCapture
}

async function runElectronHost(input: HostRunInput): Promise<HostRunOutput> {
  const prepared = await prepareHeadlessConfig({
    config: input.config,
    artifactsDirectory: input.electronArtifacts,
    environment: { NODE_ENV: 'test', PARITY_PROVIDER_KEY: 'secret' },
  })
  const events: AgentEvent[] = []
  const sentEvents: AgentEvent[] = []
  const frame = { url: 'app://bundle/index.html' } as WebFrameMain
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (_channel: string, envelope: { event?: AgentEvent }) => {
      if (envelope.event) sentEvents.push(structuredClone(envelope.event))
    },
  } as unknown as WebContents
  const runtime = await createAgentRuntime({
    configStore: prepared.configStore,
    userDataDirectory: prepared.userDataDirectory,
    promptDirectory: path.resolve('resources', 'prompts'),
    providerFactory: () => input.provider,
    eventListeners: [
      { onAgentEvent: (event) => events.push(event) },
      createElectronRuntimeEventListener(() => webContents),
    ],
  })
  const workbench = new WorkbenchStore(
    path.join(prepared.userDataDirectory, 'workbench.json'),
  )
  await workbench.initialize()
  const handlers = createAppIpcHandlers({
    configStore: prepared.configStore,
    sessionManager: runtime.services.sessions,
    skillsManager: runtime.services.skills,
    traceService: runtime.services.traces,
    changeHistory: runtime.services.changes,
    workbenchStore: workbench,
    projectMetadata: runtime.services.projects,
    codeBackends: runtime.services.codeBackends,
    mcpManager: runtime.services.mcp,
    getMainWindow: () => undefined,
  })
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as IpcMainInvokeEvent
  const invoke = async <Channel extends IpcChannel>(
    channel: Channel,
    payload: IpcPayload<Channel>,
  ): Promise<Extract<IpcResult<Channel>, { ok: true }>['value']> => {
    const result = await handleIpcInvocation(channel, event, payload, {
      getTrustedWebContents: () => webContents,
      isAllowedUrl: () => true,
      handlers,
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as Extract<IpcResult<Channel>, { ok: true }>['value']
  }

  try {
    const created = await invoke('session:create', {
      version: 1,
      conversationId: 'parity-conversation',
      workspace: input.workspace,
      mode: 'yolo',
      provider: input.config.provider.id,
    })
    const sessionId = created.sessionId
    const started = await invoke('run:start', {
      version: 1,
      sessionId,
      message: input.task,
      clientRequestId: 'electron-parity-1',
    })
    await waitForRun(runtime, sessionId, started.runId)
    if (input.approvePlan) {
      const approved = await invoke('plan:update-status', {
        version: 1,
        sessionId,
        status: 'active',
      })
      expect(approved.accepted).toBe(true)
      const continued = await invoke('run:start', {
        version: 1,
        sessionId,
        message: 'Approve plan.',
        clientRequestId: 'electron-parity-2',
      })
      await waitForRun(runtime, sessionId, continued.runId)
    }
    const patch = await collectWorkspacePatch({
      workspace: input.workspace,
      artifactsDirectory: input.electronArtifacts,
    })
    expect(patch.status).toBe('written')
    const identity = createRuntimeIdentity({
      runtime,
      config: prepared.configStore.getPublicConfig(),
      configHash: prepared.configHash,
      caseDigest: input.config.caseDigest ?? sha256Json(input.task),
      sourceCommit: 'parity-source',
      sourceTree: 'clean',
      runtimeImageDigest: 'parity-image',
    })
    await invoke('session:close', { version: 1, sessionId })
    expect(sentEvents).toEqual(events)
    const tracePath = path.join(
      prepared.userDataDirectory,
      'traces',
      `${sessionId}.jsonl`,
    )
    return {
      identity,
      capture: {
        providerRequests: structuredClone(input.provider.requests),
        traceRequests: await readTraceRequests(tracePath),
        events,
        patch: patch.path ? await readFile(patch.path, 'utf8') : '',
      },
    }
  } finally {
    await runtime.dispose()
  }
}

async function runHeadlessHost(input: HostRunInput): Promise<HostRunOutput> {
  await rm(path.join(input.workspace, '.zch'), {
    recursive: true,
    force: true,
  })
  const events: AgentEvent[] = []
  const result: HeadlessResult = await runHeadlessAgent({
    config: input.config,
    workspace: input.workspace,
    task: input.task,
    artifactsDirectory: input.headlessArtifacts,
    timeoutMs: 10_000,
    output: new StringSink(),
    environment: { NODE_ENV: 'test', PARITY_PROVIDER_KEY: 'secret' },
    providerFactory: () => input.provider,
    sourceCommit: 'parity-source',
    sourceTree: 'clean',
    runtimeImageDigest: 'parity-image',
    eventListeners: [{ onAgentEvent: (event) => events.push(event) }],
  })
  return {
    identity: JSON.parse(
      await readFile(result.artifacts.identityPath, 'utf8'),
    ) as RuntimeIdentity,
    capture: {
      providerRequests: structuredClone(input.provider.requests),
      traceRequests: await readTraceRequests(result.artifacts.tracePath),
      events,
      patch: result.artifacts.patchPath
        ? await readFile(result.artifacts.patchPath, 'utf8')
        : '',
    },
  }
}

async function waitForRun(
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
  sessionId: SessionId,
  runId: RunId,
): Promise<void> {
  const completion = await runtime.events.waitForRun(sessionId, runId)
  expect(completion.status).toBe('completed')
  await runtime.services.sessions.waitForRunSettled(sessionId, runId)
}

async function readTraceRequests(
  filePath: string,
): Promise<ParityTraceRequest[]> {
  const lines = (await readFile(filePath, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return lines
    .filter((event) => event.type === 'llm.request')
    .map((event) => ({
      promptResources: (event.promptResources ??
        []) as ParityTraceRequest['promptResources'],
      ...(event.promptBuild
        ? {
            promptBuild: event.promptBuild as ParityTraceRequest['promptBuild'],
          }
        : {}),
    }))
}
