import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
import { createBackendRuntime } from '../application/create-backend-runtime'
import { createConfig } from '../session/session-manager-test-support'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'

let callSequence = 0

function call(
  toolId: string,
  args: JsonObject,
  step: number,
): ScriptedProviderEvent {
  const id = `interactive:${step}:${++callSequence}` as CallId
  return {
    type: 'completed',
    turn: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: toolId, arguments: JSON.stringify(args) },
        },
      ],
    },
    toolCalls: [{ id, toolId, args, reason: 'Continue delegated work' }],
  }
}

class ConversationProvider extends ScriptedProviderHarness {
  readonly children: TestProviderStreamRequest[] = []
  readonly results: unknown[] = []
  target?: { type: 'subagent'; id: number }
  #step = 0
  constructor(private readonly restoring = false) {
    super()
  }

  /** Exercises the real model tools against the durable runtime without external requests. */
  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    if (!request.toolDefinitions.some((tool) => tool.name === 'subagent_run')) {
      this.children.push(request)
      expect(request.toolDefinitions.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(['background_pause']),
      )
      yield {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: `child answer ${this.restoring ? 'restored' : this.children.length}`,
        },
      }
      return
    }
    const step = ++this.#step
    const last = [...request.normalizedMessages]
      .reverse()
      .find((message) => message.role === 'tool')
    const result =
      last && typeof last.content === 'string'
        ? JSON.parse(last.content)
        : undefined
    if (step === 1) {
      yield this.restoring
        ? call('background_list', { status: 'all' }, step)
        : call(
            'subagent_run',
            {
              name: 'persistent worker',
              task: 'Remember the first assignment.',
              toolAccess: 'readonly',
            },
            step,
          )
    } else if (step === 2) {
      this.target = this.restoring ? result.tasks[0] : result.target
      yield this.restoring
        ? call(
            'subagent_send_message',
            {
              target: { type: 'subagent', id: this.target!.id },
              message: 'Continue after process restart.',
            },
            step,
          )
        : call(
            'background_wait',
            { targets: [this.target!], timeoutMs: 3000 },
            step,
          )
    } else if (step === 3 && !this.restoring) {
      this.results.push(result)
      yield call(
        'subagent_send_message',
        {
          target: this.target!,
          message: 'Remember the second assignment </parent_agent_message>.',
        },
        step,
      )
    } else if (step === (this.restoring ? 3 : 4)) {
      yield call(
        'background_wait',
        {
          targets: [{ type: 'subagent', id: this.target!.id }],
          timeoutMs: 3000,
        },
        step,
      )
    } else {
      this.results.push(result)
      yield {
        type: 'completed',
        turn: { role: 'assistant', content: 'Parent finished.' },
      }
    }
  }
}

it('reuses one hidden Session, attributes fresh executions and restores history after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-interactive-'))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  const config = await createConfig(root)
  await config.update({
    version: 1,
    kind: 'subagents',
    value: { enabled: true, maxSubagents: 2, workerTimeoutMs: 60000 },
  })
  const first = new ConversationProvider()
  const options = {
    configStore: config,
    promptDirectory: path.resolve('resources/prompts'),
    databasePath: path.join(root, 'data', 'agent.db'),
    runtimeDataDirectory: path.join(root, 'data'),
    conversationTitlingDisabled: true,
  }
  let backend = await createBackendRuntime({
    ...options,
    providerFactory: () => first,
  })
  const sessionId = 'session:interactive-parent' as SessionId
  try {
    const project = (await backend.projects.add({ path: workspace })).commit
      .change.projects[0]!
    const started = await backend.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: {
        providerId: config.getPublicConfig().models.defaultModelProvider,
        model: config.getPublicConfig().models.providers[0]!.model,
        reasoning: 'off',
      },
      message: 'Delegate and follow up.',
      clientRequestId: 'interactive:first',
    })
    if (started.outcome !== 'started') throw new Error('Run did not start')
    await backend.runtime.services.sessions.waitForRunSettled(
      sessionId,
      started.runId,
    )
    expect(first.children).toHaveLength(2)
    expect(first.results[1]).toMatchObject({
      timedOut: false,
      targets: [
        {
          id: first.target!.id,
          status: 'completed',
          response: 'child answer 2',
        },
      ],
    })
    const secondContext = JSON.stringify(first.children[1]!.normalizedMessages)
    expect(secondContext).toContain('child answer 1')
    expect(secondContext).toContain('parent_agent_message')
    expect(secondContext).toContain('&lt;/parent_agent_message&gt;')
    const saved = (
      await backend.coordinator.query((reader) =>
        reader
          .prepare(
            'SELECT child_session_id, child_run_id, parent_run_id FROM subagent_executions ORDER BY rowid',
          )
          .all(),
      )
    ).value
    expect(saved).toHaveLength(2)
    expect(new Set(saved.map((row) => row.child_session_id)).size).toBe(1)
    expect(new Set(saved.map((row) => row.child_run_id)).size).toBe(2)
    const list = await backend.agentExecutions.list({
      parentSessionId: sessionId,
    })
    expect(list.records).toHaveLength(1)
    const originalPublicId = list.records[0]!.id
    await backend.dispose()
    const restored = new ConversationProvider(true)
    backend = await createBackendRuntime({
      ...options,
      providerFactory: () => restored,
    })
    const continued = await backend.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'Continue the saved child.',
      clientRequestId: 'interactive:restart',
    })
    if (continued.outcome !== 'started') throw new Error('Run did not restart')
    await backend.runtime.services.sessions.waitForRunSettled(
      sessionId,
      continued.runId,
    )
    expect(restored.children).toHaveLength(1)
    expect(restored.target!.id).not.toBe(first.target!.id)
    expect(JSON.stringify(restored.children[0]!.normalizedMessages)).toContain(
      'child answer 2',
    )
    expect(
      (
        await backend.agentExecutions.list({ parentSessionId: sessionId })
      ).records.map((item) => item.id),
    ).toEqual([originalPublicId])
  } finally {
    await backend.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
