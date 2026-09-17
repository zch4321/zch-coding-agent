import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import { createBackendRuntime } from '../application/create-backend-runtime'
import { createConfig, waitFor } from '../session/session-manager-test-support'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent,
  type TestProviderStreamRequest,
} from '../providers/provider-test-harness'

class WakeupProvider extends ScriptedProviderHarness {
  readonly parent: TestProviderStreamRequest[] = []
  readonly childReady: Promise<void>
  readonly #childGate: Promise<void>
  #release!: () => void
  #ready!: () => void
  constructor() {
    super()
    this.#childGate = new Promise((resolve) => {
      this.#release = resolve
    })
    this.childReady = new Promise((resolve) => {
      this.#ready = resolve
    })
  }
  /** Releases the current complete child response at a deterministic test boundary. */
  release(): void {
    this.#release()
  }
  /** Finishes the parent first, then completes its detached child on demand. */
  async *run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent> {
    if (!request.toolDefinitions.some((tool) => tool.name === 'subagent_run')) {
      this.#ready()
      await this.#childGate
      yield {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: 'Child result <verified>.',
          reasoning_content: 'private child reasoning',
        },
      }
      return
    }
    this.parent.push(request)
    if (this.parent.length === 1) {
      const args = {
        name: 'detached child',
        task: 'Finish the delegated check.',
        toolAccess: 'readonly',
      }
      const id = 'wakeup:delegate' as CallId
      yield {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name: 'subagent_run',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          { id, toolId: 'subagent_run', args, reason: 'Delegate a check' },
        ],
      }
    } else
      yield {
        type: 'completed',
        turn: { role: 'assistant', content: 'Parent answer.' },
      }
  }
}

it.each(['desktop', 'headless', 'user-stopped'] as const)(
  'wakes an idle naturally completed parent only in eligible Desktop state (%s)',
  async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-wakeup-'))
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    const config = await createConfig(root)
    await config.update({
      version: 1,
      kind: 'subagents',
      value: { enabled: true, maxSubagents: 2, workerTimeoutMs: 60000 },
    })
    const provider = new WakeupProvider()
    const backend = await createBackendRuntime({
      configStore: config,
      promptDirectory: path.resolve('resources/prompts'),
      databasePath: path.join(root, 'data', 'agent.db'),
      runtimeDataDirectory: path.join(root, 'data'),
      conversationTitlingDisabled: true,
      backgroundWakeupEnabled: mode !== 'headless',
      providerFactory: () => provider,
    })
    const sessionId = 'session:wakeup' as SessionId
    try {
      const project = (await backend.projects.add({ path: workspace })).commit
        .change.projects[0]!
      const result = await backend.runs.start({
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
        message: 'Delegate this task.',
        clientRequestId: 'wakeup:start',
      })
      if (result.outcome !== 'started') throw new Error('Parent did not start')
      await provider.childReady
      await backend.runtime.services.sessions.waitForRunSettled(
        sessionId,
        result.runId,
      )
      expect(provider.parent).toHaveLength(2)
      if (mode === 'user-stopped')
        backend.runtime.services.sessions.interruptRun(sessionId, result.runId)
      provider.release()
      if (mode === 'desktop') {
        await waitFor(() => provider.parent.length === 3)
        const notification = provider.parent[2]!.normalizedMessages.filter(
          (message) => message.role === 'user',
        ).at(-1)
        expect(notification?.content).toContain(
          '<background_task_notification>',
        )
        expect(notification?.content).toContain(
          'Child result &lt;verified&gt;.',
        )
        expect(notification?.content).not.toContain('private child reasoning')
        const snapshot =
          backend.runtime.services.sessions.activeRunSnapshot(sessionId)
        if (snapshot)
          await backend.runtime.services.sessions.waitForRunSettled(
            sessionId,
            snapshot.runId,
          )
        const history = await backend.sessions.listAllMessages(sessionId)
        expect(
          history.filter((record) => record.kind === 'user_input'),
        ).toHaveLength(1)
        expect(
          history.filter(
            (record) =>
              record.kind === 'orchestrator' &&
              record.metadata?.layer?.source === 'background.lifecycle',
          ),
        ).toHaveLength(1)
      } else {
        let completed = false
        for (let attempt = 0; attempt < 200 && !completed; attempt++) {
          completed =
            (await backend.agentExecutions.list({ parentSessionId: sessionId }))
              .records[0]?.status === 'completed'
          if (!completed)
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(completed).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(provider.parent).toHaveLength(2)
      }
    } finally {
      provider.release()
      await backend.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  15000,
)
