import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type { AgentExecutionEvent } from '../../shared/agent-execution'
import type { CallId, SessionId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'
import { createConfig, waitFor } from '../session/session-manager-test-support'
import { createBackendRuntime } from '../application/create-backend-runtime'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function toolTurn(input: {
  id: string
  calls: Array<{ id: string; toolId: string; args: JsonObject }>
  reasoning?: string
}): Extract<ScriptedProviderEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rawResponse: { id: input.id },
    turn: {
      role: 'assistant',
      content: null,
      ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
      tool_calls: input.calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.toolId,
          arguments: JSON.stringify(call.args),
        },
      })),
    },
    toolCalls: input.calls.map((call) => ({
      id: call.id as CallId,
      toolId: call.toolId,
      args: call.args,
      reason: `Use ${call.toolId}`,
    })),
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    providerState: {},
    timing: {},
  }
}

class SubagentChainProvider extends ScriptedProviderHarness {
  readonly parentRequests: TestProviderStreamRequest[] = []
  readonly childRequests: TestProviderStreamRequest[] = []
  readonly #workspace: string
  readonly #hotSwap: () => Promise<void>

  constructor(workspace: string, hotSwap: () => Promise<void>) {
    super()
    this.#workspace = workspace
    this.#hotSwap = hotSwap
  }

  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    const parent = request.toolDefinitions.some(
      (definition) => definition.name === 'subagent_run',
    )
    if (parent) {
      this.parentRequests.push(structuredClone(request))
      if (this.parentRequests.length === 1) {
        await this.#hotSwap()
        yield toolTurn({
          id: 'parent:delegate',
          calls: [
            {
              id: 'call:subagent',
              toolId: 'subagent_run',
              args: {
                name: 'live-workspace-audit',
                task: 'Inspect README.md and the current Git diff, then report both directly.',
                toolAccess: 'inherit',
              },
            },
          ],
        })
        return
      }
      if (this.parentRequests.length === 2) {
        const handleMessage = [...request.normalizedMessages]
          .reverse()
          .find(
            (message) =>
              message.role === 'tool' && typeof message.content === 'string',
          )
        const handle = JSON.parse(String(handleMessage?.content)) as {
          target?: { id?: string }
        }
        const executionId = handle.target?.id ?? ''
        yield toolTurn({
          id: 'parent:wait',
          calls: [
            {
              id: 'call:background-wait',
              toolId: 'background_wait',
              args: {
                targets: [{ type: 'subagent', id: executionId }],
                mode: 'all',
                timeoutMs: 300_000,
              },
            },
          ],
        })
        return
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'parent:complete' },
        turn: {
          role: 'assistant',
          content: 'Parent summarized the live Subagent workspace audit.',
        },
        usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
        providerState: {},
        timing: {},
      }
      return
    }

    this.childRequests.push(structuredClone(request))
    if (this.childRequests.length === 1) {
      await writeFile(
        path.join(this.#workspace, 'README.md'),
        'mutated before live read\n',
        'utf8',
      )
      yield {
        type: 'reasoning.delta',
        delta: 'Inspect the live files before reporting.',
        raw: { fixture: 'child-reasoning' },
      }
      yield toolTurn({
        id: 'child:inspect',
        reasoning: 'Inspect the live files before reporting.',
        calls: [
          {
            id: 'call:child-read',
            toolId: 'read_file',
            args: { path: 'README.md' },
          },
          {
            id: 'call:child-diff',
            toolId: 'git_diff',
            args: { flags: [], paths: [] },
          },
          {
            id: 'call:child-forged-write',
            toolId: 'write_file',
            args: { path: 'forbidden.txt', content: 'must not be written' },
          },
        ],
      })
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'child:complete' },
      turn: {
        role: 'assistant',
        content:
          'The live README and Git diff both show “mutated before live read”.',
        reasoning_content: 'Summarize the verified workspace evidence.',
      },
      usage: {
        prompt_tokens: 30,
        completion_tokens: 8,
        total_tokens: 38,
        prompt_cache_hit_tokens: 5,
      },
      providerState: {},
      timing: {},
    }
  }
}

class WritableSubagentProvider extends ScriptedProviderHarness {
  readonly parentRequests: TestProviderStreamRequest[] = []
  readonly childRequests: TestProviderStreamRequest[] = []

  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    const parent = request.toolDefinitions.some(
      (definition) => definition.name === 'subagent_run',
    )
    if (parent) {
      this.parentRequests.push(structuredClone(request))
      if (this.parentRequests.length === 1) {
        yield toolTurn({
          id: 'parent:delegate-writer',
          calls: [
            {
              id: 'call:subagent-writer',
              toolId: 'subagent_run',
              args: {
                name: 'workspace-writer',
                task: 'Create inherited-write.txt with the requested fixture content.',
                toolAccess: 'inherit',
              },
            },
          ],
        })
        return
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'parent:writer-complete' },
        turn: {
          role: 'assistant',
          content: 'Parent received the completed writable child result.',
        },
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    this.childRequests.push(structuredClone(request))
    if (this.childRequests.length === 1) {
      yield toolTurn({
        id: 'child:create-file',
        calls: [
          {
            id: 'call:child-create-file',
            toolId: 'create_file',
            args: {
              path: 'inherited-write.txt',
              content: 'written by inherited child\n',
            },
          },
        ],
      })
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'child:writer-complete' },
      turn: {
        role: 'assistant',
        content: 'Created inherited-write.txt after approval.',
      },
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

async function git(workspace: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: workspace })
}

describe('read-only Subagent runtime', () => {
  it('does not elevate inherited access from a read-only parent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-subagent-runtime-'))
    cleanup.push(root)
    const workspace = path.join(root, 'workspace')
    const targetDirectory = path.join(root, 'runtime')
    await mkdir(workspace)
    await git(workspace, ['init', '--quiet'])
    await writeFile(
      path.join(workspace, 'README.md'),
      'committed base\n',
      'utf8',
    )
    await git(workspace, ['add', 'README.md'])
    await git(workspace, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'base',
    ])
    await writeFile(
      path.join(workspace, 'README.md'),
      'dirty before child start\n',
      'utf8',
    )
    const refsBefore = (
      await execFileAsync('git', ['for-each-ref', '--format=%(refname)'], {
        cwd: workspace,
      })
    ).stdout
    const legacySnapshots = path.join(
      targetDirectory,
      'subagent-snapshots',
      'orphan',
    )
    await mkdir(legacySnapshots, { recursive: true })
    await writeFile(path.join(legacySnapshots, 'marker'), 'legacy', 'utf8')

    const store = await createConfig(root)
    await store.update({
      version: 1,
      kind: 'subagents',
      value: {
        enabled: true,
        workerTimeoutMs: 60_000,
        maxSubagents: 32,
      },
    })
    const originalModel = store.getPublicConfig().models.providers[0]!.model
    let swapped = false
    const provider = new SubagentChainProvider(workspace, async () => {
      if (swapped) return
      swapped = true
      const configured = store.getPublicConfig().models.providers[0]!
      await store.update({
        version: 1,
        kind: 'provider',
        providerId: configured.id,
        baseURL: configured.baseURL,
        model: 'hot-swapped-model',
      })
    })
    const events: AgentEvent[] = []
    const executionEvents: AgentExecutionEvent[] = []
    const target = await createBackendRuntime({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      databasePath: path.join(targetDirectory, 'agent.db'),
      runtimeDataDirectory: targetDirectory,
      conversationTitlingDisabled: true,
      providerFactory: () => provider,
      eventListeners: [
        {
          onAgentEvent: (event) => events.push(event),
          onAgentExecutionEvent: (event) => executionEvents.push(event),
        },
      ],
    })
    try {
      const project = (await target.projects.add({ path: workspace })).commit
        .change.projects[0]!
      const sessionId = 'session:subagent-parent' as SessionId
      const started = await target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'readonly',
        modelSelection: {
          providerId: store.getPublicConfig().models.defaultModelProvider,
          model: originalModel,
          reasoning: 'off',
        },
        message: 'Delegate a live workspace audit.',
        clientRequestId: 'request:subagent-e2e',
      })
      if (started.outcome !== 'started')
        throw new Error('Parent Run did not start')
      await target.runtime.services.sessions.waitForRunSettled(
        sessionId,
        started.runId,
      )
      await waitFor(() =>
        executionEvents.some(
          (event) =>
            event.type === 'execution.changed' &&
            event.summary.status === 'completed',
        ),
      )

      expect(
        events.find(
          (event) =>
            event.type === 'run.status' &&
            event.runId === started.runId &&
            event.status === 'completed',
        ),
      ).toBeDefined()
      expect(events.every((event) => event.sessionId === sessionId)).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'llm.usage' && event.usage.scope === 'subagent',
        ),
      ).toBe(true)

      expect(executionEvents.length).toBeGreaterThan(0)
      expect(
        new Set(executionEvents.map((event) => event.executionId)).size,
      ).toBe(1)
      expect(executionEvents.map((event) => event.seq)).toEqual(
        Array.from({ length: executionEvents.length }, (_, index) => index + 1),
      )
      expect(
        executionEvents.every(
          (event) =>
            event.parentSessionId === sessionId &&
            event.parentRunId === started.runId,
        ),
      ).toBe(true)
      expect(executionEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'execution.changed',
          'run.status',
          'assistant.message.completed',
          'tool.proposed',
          'tool.completed',
          'llm.usage',
        ]),
      )
      const executionUsage = executionEvents.find(
        (event) => event.type === 'llm.usage',
      )
      expect(executionUsage).toMatchObject({
        type: 'llm.usage',
        usage: { scope: 'subagent' },
      })

      expect(provider.parentRequests).toHaveLength(3)
      expect(provider.childRequests).toHaveLength(2)
      for (const request of [
        ...provider.parentRequests,
        ...provider.childRequests,
      ]) {
        expect(request.providerRequest.model).toBe(originalModel)
      }
      const childTools = provider.childRequests[0]!.toolDefinitions.map(
        (definition) => definition.name,
      )
      expect(childTools).toEqual(
        expect.arrayContaining([
          'read_file',
          'git_diff',
          'read_skill',
          'delay',
        ]),
      )
      for (const forbidden of [
        'subagent_run',
        'swarm_run',
        'background_wait',
        'background_list',
        'background_cancel',
        'write_file',
        'apply_patch',
        'run_command',
        'web_search',
        'code_find_definition',
      ]) {
        expect(childTools).not.toContain(forbidden)
      }

      const firstChildHistory = JSON.stringify(
        provider.childRequests[0]!.normalizedMessages,
      )
      expect(firstChildHistory).toContain(
        'Inspect README.md and the current Git diff, then report both directly.',
      )
      expect(firstChildHistory).not.toContain(
        'Delegate a live workspace audit.',
      )
      const secondChildHistory = JSON.stringify(
        provider.childRequests[1]!.normalizedMessages,
      )
      expect(secondChildHistory).toContain('mutated before live read')
      expect(secondChildHistory).not.toContain('dirty before child start')
      expect(secondChildHistory).toContain('TOOL_NOT_AVAILABLE')
      expect(
        JSON.stringify(provider.parentRequests[2]!.normalizedMessages),
      ).toContain('The live README and Git diff both show')

      const parent = await target.sessions.get(sessionId)
      const parentJson = JSON.stringify(parent)
      expect(parentJson).toContain(
        'Parent summarized the live Subagent workspace audit.',
      )
      expect(parentJson).toContain('live-workspace-audit')
      expect(parentJson).not.toContain('subagent-session-')
      expect(
        (await target.sessions.list()).records.map((record) => record.id),
      ).toEqual([sessionId])

      const executionPage = await target.agentExecutions.list({
        parentSessionId: sessionId,
      })
      expect(executionPage).toMatchObject({
        hasMore: false,
        records: [
          {
            name: 'live-workspace-audit',
            status: 'completed',
            usage: { records: 2, totalTokens: 52 },
          },
        ],
      })
      const executionDetail = await target.agentExecutions.get({
        parentSessionId: sessionId,
        executionId: executionPage.records[0]!.id,
      })
      expect(executionDetail.task).toContain('Inspect README.md')
      expect(executionDetail.activityPage.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'reasoning',
            text: 'Inspect the live files before reporting.',
          }),
          expect.objectContaining({
            type: 'tool',
            tool: 'read_file',
            status: 'completed',
          }),
          expect.objectContaining({
            type: 'message',
            text: expect.stringContaining('mutated before live read'),
          }),
        ]),
      )

      const durable = (
        await target.coordinator.query((reader) => ({
          execution: reader
            .prepare(
              `SELECT status, route_json, source_identity_json, usage_json,
                      result_json, error_code
               FROM subagent_executions`,
            )
            .get(),
          hiddenCount: reader
            .prepare('SELECT count(*) AS count FROM subagent_sessions')
            .get(),
        }))
      ).value as {
        execution: Record<string, unknown>
        hiddenCount: { count: number }
      }
      expect(durable.execution).toMatchObject({
        status: 'completed',
        error_code: null,
        source_identity_json: null,
      })
      expect(durable.hiddenCount).toEqual({ count: 1 })
      const hiddenSessionId = (
        await target.coordinator.query((reader) =>
          reader
            .prepare('SELECT session_id FROM subagent_sessions LIMIT 1')
            .get(),
        )
      ).value as { session_id: string }
      expect(JSON.stringify(executionEvents)).not.toContain(
        hiddenSessionId.session_id,
      )
      const persisted = JSON.stringify(durable.execution)
      expect(persisted).not.toContain('secret-sentinel')
      expect(persisted).not.toContain('subagent-snapshots')
      expect(persisted).not.toContain('subagent-session-')
      await expect(
        readdir(path.join(targetDirectory, 'subagent-snapshots')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (
          await execFileAsync('git', ['for-each-ref', '--format=%(refname)'], {
            cwd: workspace,
          })
        ).stdout,
      ).toBe(refsBefore)
    } finally {
      await target.dispose()
    }
  }, 30_000)

  it('inherits a new reasoning level into the hidden child session', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'zch-subagent-reasoning-'),
    )
    cleanup.push(root)
    const workspace = path.join(root, 'workspace')
    const targetDirectory = path.join(root, 'runtime')
    await mkdir(workspace)
    await git(workspace, ['init', '--quiet'])
    await writeFile(path.join(workspace, 'README.md'), 'base\n', 'utf8')
    await git(workspace, ['add', 'README.md'])
    await git(workspace, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'base',
    ])

    const store = await createConfig(root)
    await store.update({
      version: 1,
      kind: 'subagents',
      value: {
        enabled: true,
        workerTimeoutMs: 60_000,
        maxSubagents: 32,
      },
    })
    const provider = new SubagentChainProvider(workspace, async () => undefined)
    const target = await createBackendRuntime({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      databasePath: path.join(targetDirectory, 'agent.db'),
      runtimeDataDirectory: targetDirectory,
      conversationTitlingDisabled: true,
      providerFactory: () => provider,
    })
    try {
      const project = (await target.projects.add({ path: workspace })).commit
        .change.projects[0]!
      const sessionId = 'session:subagent-reasoning-parent' as SessionId
      const started = await target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'readonly',
        modelSelection: {
          providerId: store.getPublicConfig().models.defaultModelProvider,
          model: store.getPublicConfig().models.providers[0]!.model,
          reasoning: 'medium',
        },
        message: 'Delegate with a new reasoning level.',
        clientRequestId: 'request:subagent-reasoning',
      })
      if (started.outcome !== 'started')
        throw new Error('Parent Run did not start')
      await target.runtime.services.sessions.waitForRunSettled(
        sessionId,
        started.runId,
      )
      await waitFor(() => provider.childRequests.length > 0)

      // The child inherits the parent's frozen route, including the new level.
      expect(provider.childRequests[0]!.providerRequest).toMatchObject({
        reasoning_effort: 'medium',
      })

      // The hidden child session persisted the inherited new level.
      const durable = (
        await target.coordinator.query((reader) =>
          reader
            .prepare(
              `SELECT sessions.reasoning AS reasoning
               FROM subagent_sessions
               JOIN sessions ON sessions.id = subagent_sessions.session_id`,
            )
            .get(),
        )
      ).value as { reasoning: string }
      expect(durable.reasoning).toBe('medium')
    } finally {
      await target.dispose()
    }
  }, 30_000)
})

describe('write-capable Subagent runtime', () => {
  it('inherits confirm mode and resumes after a projected child approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-subagent-write-'))
    cleanup.push(root)
    const workspace = path.join(root, 'workspace')
    const runtimeDirectory = path.join(root, 'runtime')
    await mkdir(workspace)

    const store = await createConfig(root)
    await store.update({
      version: 1,
      kind: 'subagents',
      value: {
        enabled: true,
        workerTimeoutMs: 60_000,
        maxSubagents: 32,
      },
    })
    const provider = new WritableSubagentProvider()
    const executionEvents: AgentExecutionEvent[] = []
    const target = await createBackendRuntime({
      configStore: store,
      promptDirectory: path.resolve('resources', 'prompts'),
      databasePath: path.join(runtimeDirectory, 'agent.db'),
      runtimeDataDirectory: runtimeDirectory,
      conversationTitlingDisabled: true,
      providerFactory: () => provider,
      eventListeners: [
        {
          onAgentEvent: () => undefined,
          onAgentExecutionEvent: (event) => executionEvents.push(event),
        },
      ],
    })
    try {
      const project = (await target.projects.add({ path: workspace })).commit
        .change.projects[0]!
      const sessionId = 'session:writable-subagent-parent' as SessionId
      const configured = store.getPublicConfig()
      const started = await target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'confirm',
        modelSelection: {
          providerId: configured.models.defaultModelProvider,
          model: configured.models.defaultModel,
          reasoning: 'off',
        },
        message: 'Delegate the requested file creation.',
        clientRequestId: 'request:writable-subagent',
      })
      if (started.outcome !== 'started') {
        throw new Error('Writable parent Run did not start')
      }

      await waitFor(() =>
        executionEvents.some((event) => event.type === 'approval.requested'),
      )
      const approval = executionEvents.find(
        (
          event,
        ): event is Extract<
          AgentExecutionEvent,
          { type: 'approval.requested' }
        > => event.type === 'approval.requested',
      )!
      expect(approval.approval).toMatchObject({
        callId: 'call:child-create-file',
        tool: 'create_file',
        arguments: { path: 'inherited-write.txt' },
      })
      expect(
        target.runtime.services.sessions.decideAgentExecutionApproval({
          parentSessionId: sessionId,
          executionId: approval.executionId,
          callId: approval.approval.callId,
          decision: 'allow',
        }),
      ).toBe(true)

      await target.runtime.services.sessions.waitForRunSettled(
        sessionId,
        started.runId,
      )
      await waitFor(() =>
        executionEvents.some(
          (event) =>
            event.type === 'execution.changed' &&
            event.summary.status === 'completed',
        ),
      )
      expect(
        await readFile(path.join(workspace, 'inherited-write.txt'), 'utf8'),
      ).toBe('written by inherited child\n')
      expect(provider.childRequests).toHaveLength(2)
      const childTools = provider.childRequests[0]!.toolDefinitions.map(
        (definition) => definition.name,
      )
      expect(childTools).toContain('create_file')
      expect(childTools).not.toContain('subagent_run')
      expect(childTools).not.toContain('swarm_run')
      expect(childTools).not.toContain('background_wait')
      expect(childTools).not.toContain('background_list')
      expect(childTools).not.toContain('background_cancel')
      expect(
        executionEvents.some(
          (event) =>
            event.type === 'execution.changed' &&
            event.summary.status === 'completed',
        ),
      ).toBe(true)
    } finally {
      await target.dispose()
    }
  }, 30_000)
})
