import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { ModelSelection } from '../../shared/model-route'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import type { ConfigStore } from '../config/store'
import { createConfig, waitFor } from '../session/session-manager-test-support'
import {
  createBackendRuntime,
  type BackendRuntime,
  type CreateBackendRuntimeOptions,
} from './create-backend-runtime'

type DurableTargetRuntime = BackendRuntime

function createBackendForTest(
  options: Omit<
    CreateBackendRuntimeOptions,
    'databasePath' | 'runtimeDataDirectory'
  > & { targetDirectory: string },
) {
  const { targetDirectory, ...runtimeOptions } = options
  return createBackendRuntime({
    ...runtimeOptions,
    conversationTitlingDisabled: true,
    databasePath: path.join(targetDirectory, 'agent.db'),
    runtimeDataDirectory: targetDirectory,
  })
}

class RecoveryProvider extends ScriptedProviderHarness {
  calls = 0
  readonly requests: ProviderStreamRequest['normalizedMessages'][] = []
  toolOnCall?: number

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === this.toolOnCall) {
      const args = { path: 'README.md' }
      yield {
        type: 'completed',
        rawResponse: { id: `tool:${this.calls}` },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call:recovery:${this.calls}`,
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: `call:recovery:${this.calls}` as CallId,
            toolId: 'read_file',
            args,
            reason: '',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: `answer:${this.calls}` },
      turn: { role: 'assistant', content: `answer ${this.calls}` },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

async function setupTarget(): Promise<{
  root: string
  workspace: string
  provider: RecoveryProvider
  store: ConfigStore
  selection: ModelSelection
  target: DurableTargetRuntime
  project: Awaited<ReturnType<DurableTargetRuntime['projects']['get']>>
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p4-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'README.md'), 'recovery fixture')
  const provider = new RecoveryProvider()
  const store = await createConfig(root)
  const configuredProvider = store.getPublicConfig().models.providers[0]!
  const selection: ModelSelection = {
    providerId: configuredProvider.id,
    model: configuredProvider.model,
    reasoning:
      configuredProvider.reasoning === 'off'
        ? 'off'
        : configuredProvider.reasoning === 'max'
          ? 'max'
          : 'high',
  }
  const target = await createBackendForTest({
    configStore: store,
    promptDirectory: path.resolve('resources', 'prompts'),
    targetDirectory: path.join(root, 'target'),
    providerFactory: () => provider,
  })
  const project = (await target.projects.add({ path: workspace })).commit.change
    .projects[0]!
  return { root, workspace, provider, store, selection, target, project }
}

async function seedSession(
  target: DurableTargetRuntime,
  projectId: Parameters<DurableTargetRuntime['projects']['get']>[0],
  sessionId: SessionId,
  selection: ModelSelection,
): Promise<void> {
  const started = await target.runs.start({
    version: 1,
    kind: 'new_session',
    sessionId,
    projectId,
    permissionMode: 'readonly',
    modelSelection: selection,
    message: 'durable seed',
    clientRequestId: `request:seed:${sessionId}`,
  })
  if (started.outcome !== 'started') throw new Error('Seed Run did not start')
  await target.runtime.services.sessions.waitForRunSettled(
    sessionId,
    started.runId,
  )
}

describe('durable lifecycle ownership and recovery', () => {
  it('gives one concurrent candidate owner and leaves the winner usable', async () => {
    const { target, project, provider, selection } = await setupTarget()
    const sessionId = 'session:reservation-race' as SessionId
    const first = target.runs.start({
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId: project.id,
      permissionMode: 'readonly',
      modelSelection: selection,
      message: 'winning first send',
      clientRequestId: 'request:reservation-winner',
    })
    await expect(
      target.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        permissionMode: 'readonly',
        modelSelection: selection,
        message: 'losing first send',
        clientRequestId: 'request:reservation-loser',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const winner = await first
    expect(winner.outcome).toBe('started')
    if (winner.outcome !== 'started') throw new Error('Winner did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      winner.runId,
    )
    const followUp = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'winner remains usable',
      clientRequestId: 'request:reservation-follow-up',
    })
    if (followUp.outcome !== 'started') {
      throw new Error('Follow-up did not start')
    }
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      followUp.runId,
    )
    expect(provider.calls).toBe(2)
    expect(JSON.stringify(await target.sessions.get(sessionId))).not.toContain(
      'losing first send',
    )
    await target.dispose()
  })

  it('recovers a failed run-input commit without carrying it into the next Run', async () => {
    const { target, project, provider, selection } = await setupTarget()
    const sessionId = 'session:run-input-recovery' as SessionId
    await seedSession(target, project.id, sessionId, selection)
    const originalCommit = target.sessions.commitMutation.bind(target.sessions)
    let injected = false
    vi.spyOn(target.sessions, 'commitMutation').mockImplementation(
      async (input) => {
        if (
          !injected &&
          input.messages?.some(
            (record) =>
              record.kind === 'user_input' &&
              'clientRequestId' in record &&
              record.clientRequestId === 'request:failed-run-input',
          )
        ) {
          injected = true
          throw new Error('injected run-input commit failure')
        }
        return originalCommit(input)
      },
    )

    await expect(
      target.runs.start({
        version: 1,
        kind: 'existing_session',
        sessionId,
        message: 'FAILED_RUN_INPUT_SENTINEL',
        clientRequestId: 'request:failed-run-input',
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(JSON.stringify(await target.sessions.get(sessionId))).not.toContain(
      'FAILED_RUN_INPUT_SENTINEL',
    )

    const next = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'clean next input',
      clientRequestId: 'request:clean-after-input-failure',
    })
    if (next.outcome !== 'started') throw new Error('Next Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      next.runId,
    )
    const saved = JSON.stringify(await target.sessions.get(sessionId))
    expect(saved).not.toContain('FAILED_RUN_INPUT_SENTINEL')
    expect(saved).toContain('clean next input')
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain(
      'FAILED_RUN_INPUT_SENTINEL',
    )
    await target.dispose()
  })

  it('recovers an assistant commit failure without later persisting that answer', async () => {
    const { target, project, selection } = await setupTarget()
    const sessionId = 'session:assistant-recovery' as SessionId
    await seedSession(target, project.id, sessionId, selection)
    const originalCommit = target.sessions.commitMutation.bind(target.sessions)
    let injected = false
    vi.spyOn(target.sessions, 'commitMutation').mockImplementation(
      async (input) => {
        if (
          !injected &&
          input.messages?.some(
            (record) =>
              record.kind === 'assistant_turn' &&
              record.parts.some(
                (part) => part.type === 'text' && part.text === 'answer 2',
              ),
          )
        ) {
          injected = true
          throw new Error('injected assistant commit failure')
        }
        return originalCommit(input)
      },
    )

    const failed = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'request answer that fails commit',
      clientRequestId: 'request:failed-assistant',
    })
    if (failed.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      failed.runId,
    )
    expect(JSON.stringify(await target.sessions.get(sessionId))).not.toContain(
      'answer 2',
    )

    const next = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'request clean answer',
      clientRequestId: 'request:clean-after-assistant-failure',
    })
    if (next.outcome !== 'started') throw new Error('Next Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      next.runId,
    )
    const saved = JSON.stringify(await target.sessions.get(sessionId))
    expect(saved).not.toContain('answer 2')
    expect(saved).toContain('answer 3')
    await target.dispose()
  })

  it('rolls back and evicts after a tool-batch commit failure', async () => {
    const { target, project, provider, selection } = await setupTarget()
    const sessionId = 'session:tool-batch-recovery' as SessionId
    await seedSession(target, project.id, sessionId, selection)
    provider.toolOnCall = 2
    const originalCommit = target.sessions.commitMutation.bind(target.sessions)
    let injected = false
    vi.spyOn(target.sessions, 'commitMutation').mockImplementation(
      async (input) => {
        if (
          !injected &&
          input.messages?.some((record) => record.kind === 'tool_result')
        ) {
          injected = true
          throw new Error('injected tool-batch commit failure')
        }
        return originalCommit(input)
      },
    )

    const failed = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'read before injected batch failure',
      clientRequestId: 'request:failed-tool-batch',
    })
    if (failed.outcome !== 'started') throw new Error('Run did not start')
    await target.runtime.services.sessions
      .waitForRunSettled(sessionId, failed.runId)
      .catch(() => undefined)
    await waitFor(
      () => !target.runtime.services.sessions.hasLiveSession(sessionId),
    )
    const afterFailure = await target.sessions.get(sessionId)
    expect(
      afterFailure.messagePage.records.some(
        (record) =>
          record.kind === 'tool_result' ||
          (record.kind === 'assistant_turn' &&
            record.parts.some((part) => part.type === 'tool_call')),
      ),
    ).toBe(false)

    const next = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'continue after isolated batch',
      clientRequestId: 'request:after-tool-batch',
    })
    if (next.outcome !== 'started') throw new Error('Next Run did not start')
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      next.runId,
    )
    expect(JSON.stringify(await target.sessions.get(sessionId))).toContain(
      'answer 3',
    )
    await target.dispose()
  })

  it('isolates the live binding when commit recovery cannot reload SQLite', async () => {
    const { target, project, selection } = await setupTarget()
    const sessionId = 'session:reload-failure' as SessionId
    await seedSession(target, project.id, sessionId, selection)
    const originalCommit = target.sessions.commitMutation.bind(target.sessions)
    const originalLoad = target.sessions.loadRuntimeState.bind(target.sessions)
    let commitFailed = false
    let reloadFailed = false
    vi.spyOn(target.sessions, 'commitMutation').mockImplementation(
      async (input) => {
        if (!commitFailed) {
          commitFailed = true
          throw new Error('injected commit failure before reload failure')
        }
        return originalCommit(input)
      },
    )
    vi.spyOn(target.sessions, 'loadRuntimeState').mockImplementation(
      async (...args) => {
        if (!reloadFailed) {
          reloadFailed = true
          throw new Error('injected SQLite reload failure')
        }
        return originalLoad(...args)
      },
    )

    await expect(
      target.runs.start({
        version: 1,
        kind: 'existing_session',
        sessionId,
        message: 'INVALID_BINDING_SENTINEL',
        clientRequestId: 'request:reload-failure',
      }),
    ).rejects.toBeInstanceOf(Error)
    await waitFor(
      () => !target.runtime.services.sessions.hasLiveSession(sessionId),
    )
    expect(JSON.stringify(await target.sessions.get(sessionId))).not.toContain(
      'INVALID_BINDING_SENTINEL',
    )

    const reloaded = await target.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'fresh Run after eviction',
      clientRequestId: 'request:after-reload-failure',
    })
    if (reloaded.outcome !== 'started') {
      throw new Error('Reloaded Run did not start')
    }
    await target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      reloaded.runId,
    )
    expect(JSON.stringify(await target.sessions.get(sessionId))).toContain(
      'fresh Run after eviction',
    )
    await target.dispose()
  })

  it('blocks runs and lifecycle eviction during an idle metadata mutation', async () => {
    const { target, project, selection } = await setupTarget()
    const sessionId = 'session:metadata-lease' as SessionId
    await seedSession(target, project.id, sessionId, selection)
    const beforeMutation = await target.sessions.getRecord(sessionId)
    const originalCommit = target.sessions.commitMutation.bind(target.sessions)
    let releaseCommit!: () => void
    const mayCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    let markCommit!: () => void
    const commitEntered = new Promise<void>((resolve) => {
      markCommit = resolve
    })
    let held = false
    vi.spyOn(target.sessions, 'commitMutation').mockImplementation(
      async (input) => {
        if (!held) {
          held = true
          markCommit()
          await mayCommit
        }
        return originalCommit(input)
      },
    )

    const mutation = target.runtime.services.sessions.updateSessionMode(
      sessionId,
      'confirm',
    )
    await commitEntered
    expect(() =>
      target.runtime.services.sessions.startRun({
        sessionId,
        message: 'must not cross metadata commit',
        clientRequestId: 'request:during-metadata',
      }),
    ).toThrow(/metadata mutation/u)
    await expect(
      target.sessions.archive({
        sessionId,
        expectedRevision: beforeMutation.revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    releaseCommit()
    await expect(mutation).resolves.toEqual({ accepted: true })
    await target.dispose()
  })

  it('blocks archive and Project mutation throughout deferred restore', async () => {
    const first = await setupTarget()
    const sessionId = 'session:deferred-restore' as SessionId
    await seedSession(
      first.target,
      first.project.id,
      sessionId,
      first.selection,
    )
    const session = await first.target.sessions.getRecord(sessionId)
    await first.target.dispose()

    const provider = new RecoveryProvider()
    const second = await createBackendForTest({
      configStore: first.store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: path.join(first.root, 'target'),
      providerFactory: () => provider,
    })
    const replacementWorkspace = path.join(first.root, 'replacement')
    await mkdir(replacementWorkspace)
    const originalLoad = second.sessions.loadRuntimeState.bind(second.sessions)
    let releaseRestore!: () => void
    const mayRestore = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    let markLoading!: () => void
    const loading = new Promise<void>((resolve) => {
      markLoading = resolve
    })
    vi.spyOn(second.sessions, 'loadRuntimeState').mockImplementation(
      async (...args) => {
        const durable = await originalLoad(...args)
        markLoading()
        await mayRestore
        return durable
      },
    )

    const start = second.runs.start({
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'load through lifecycle barrier',
      clientRequestId: 'request:deferred-restore',
    })
    await loading
    await expect(
      second.sessions.archive({
        sessionId,
        expectedRevision: session.revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      second.projects.update({
        projectId: first.project.id,
        expectedRevision: first.project.revision,
        patch: { path: replacementWorkspace },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      second.projects.remove({
        projectId: first.project.id,
        expectedRevision: first.project.revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    releaseRestore()
    const started = await start
    if (started.outcome !== 'started') throw new Error('Run did not start')
    await second.runtime.services.sessions.waitForRunSettled(
      sessionId,
      started.runId,
    )
    expect((await second.sessions.getRecord(sessionId)).lifecycle).toBe(
      'active',
    )
    expect((await second.projects.get(first.project.id)).path).toBe(
      first.project.path,
    )
    await second.dispose()
  })
})
