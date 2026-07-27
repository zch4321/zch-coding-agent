import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import { YOLO_NOTICE_VERSION } from '../../shared/notices'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import { createConfig } from '../session/session-manager-test-support'
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
    databasePath: path.join(targetDirectory, 'agent.db'),
    runtimeDataDirectory: targetDirectory,
  })
}

class FileMutationProvider extends ScriptedProviderHarness {
  calls = 0
  readonly requests: ProviderStreamRequest['normalizedMessages'][] = []

  constructor(
    readonly toolId: 'create_file' | 'apply_patch' | 'delete_file',
    readonly args: Record<string, string>,
  ) {
    super()
  }

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === 1) {
      const callId = `call:file-change:${this.toolId}` as CallId
      yield {
        type: 'completed',
        rawResponse: { id: `response:${callId}` },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: {
                name: this.toolId,
                arguments: JSON.stringify(this.args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: callId,
            toolId: this.toolId,
            args: this.args,
            reason: 'Exercise durable file-change recording',
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
      rawResponse: { id: 'response:file-change:final' },
      turn: { role: 'assistant', content: 'File mutation handled' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class MultiFileMutationProvider extends FileMutationProvider {
  constructor() {
    super('create_file', {})
  }

  override async *run(
    request: ProviderStreamRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === 1) {
      const mutations = [
        {
          id: 'call:file-change:multi-a' as CallId,
          path: 'multi-a.txt',
          content: 'multi a',
        },
        {
          id: 'call:file-change:multi-b' as CallId,
          path: 'multi-b.txt',
          content: 'multi b',
        },
      ]
      yield {
        type: 'completed',
        rawResponse: { id: 'response:file-change:multi' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: mutations.map((mutation) => ({
            id: mutation.id,
            type: 'function' as const,
            function: {
              name: 'create_file',
              arguments: JSON.stringify({
                path: mutation.path,
                content: mutation.content,
              }),
            },
          })),
        },
        toolCalls: mutations.map((mutation) => ({
          id: mutation.id,
          toolId: 'create_file',
          args: { path: mutation.path, content: mutation.content },
          reason: 'Exercise independent durable mutation records',
        })),
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'response:file-change:multi-final' },
      turn: { role: 'assistant', content: 'Both files created' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

describe('P5 durable file tool execution', () => {
  it('records SQLite history before the tool batch without dual-writing JSON', async () => {
    const setup = await setupTarget(
      new FileMutationProvider('create_file', {
        path: 'created.txt',
        content: 'durable file content',
      }),
    )
    const topics: string[] = []
    const unsubscribe = setup.target.subscribe((commit) => {
      topics.push(commit.topic)
    })
    const sessionId = 'session:durable-file-create' as SessionId
    const runId = await startFileRun(setup, sessionId)
    await setup.target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      runId,
    )
    const completion = await setup.target.runtime.events.waitForRun(
      sessionId,
      runId,
    )
    if (completion.status !== 'completed') {
      throw new Error(completion.error?.message ?? completion.status)
    }
    unsubscribe()

    expect(
      await readFile(path.join(setup.workspace, 'created.txt'), 'utf8'),
    ).toBe('durable file content')
    const page = await setup.target.fileChanges.list(sessionId)
    expect(page.records).toHaveLength(1)
    expect(page.records[0]).toMatchObject({
      sessionId,
      path: 'created.txt',
      operation: 'write',
      beforeExists: false,
      afterExists: true,
      revision: 1,
    })
    const messages = await setup.target.sessions.listMessages(sessionId)
    expect(JSON.stringify(messages.records)).toContain(
      `"fileChangeId":"${page.records[0]!.id}"`,
    )
    expect(JSON.stringify(messages.records)).toContain(
      '"mutationSucceeded":true',
    )
    expect(JSON.stringify(messages.records)).toContain('"revertAvailable":true')
    const fileChangeCommit = topics.indexOf('file-change.changed')
    expect(fileChangeCommit).toBeGreaterThanOrEqual(0)
    expect(topics.slice(fileChangeCommit + 1)).toContain('session.changed')

    await expect(
      readFile(path.join(setup.targetDirectory, 'change-history.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(page)).not.toContain('beforeContent')
    expect(JSON.stringify(messages)).not.toContain('beforeContent')
    const traceFiles = (
      await readdir(setup.target.runtime.services.traces.directory, {
        recursive: true,
      })
    ).filter((entry) => entry.endsWith('.jsonl'))
    const traces = (
      await Promise.all(
        traceFiles.map((entry) =>
          readFile(
            path.join(setup.target.runtime.services.traces.directory, entry),
            'utf8',
          ),
        ),
      )
    ).join('\n')
    expect(traces).not.toContain('beforeContent')
    expect(traces).not.toContain('before_content')

    await setup.target.dispose()
    const reopened = await createBackendForTest({
      configStore: setup.store,
      promptDirectory: path.resolve('resources', 'prompts'),
      targetDirectory: setup.targetDirectory,
      providerFactory: () => setup.provider,
    })
    try {
      const durablePage = await reopened.fileChanges.list(sessionId)
      const durableChange = durablePage.records[0]!
      const reverted = await reopened.fileChanges.revert(
        sessionId,
        durableChange.id,
        durableChange.revision,
      )
      expect(reverted.commit.change).toMatchObject({
        mode: 'upsert',
        sessionId,
        fileChange: {
          id: durableChange.id,
          revision: 2,
          revertedAt: expect.any(String),
        },
      })
      await expect(
        readFile(path.join(setup.workspace, 'created.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await reopened.dispose()
    }
  })

  it('records each mutation in a multi-call batch before one atomic Message commit', async () => {
    const setup = await setupTarget(new MultiFileMutationProvider())
    const topics: string[] = []
    const unsubscribe = setup.target.subscribe((commit) => {
      topics.push(commit.topic)
    })
    const sessionId = 'session:durable-file-multi' as SessionId
    const runId = await startFileRun(setup, sessionId)
    await setup.target.runtime.services.sessions.waitForRunSettled(
      sessionId,
      runId,
    )
    unsubscribe()

    expect(
      await readFile(path.join(setup.workspace, 'multi-a.txt'), 'utf8'),
    ).toBe('multi a')
    expect(
      await readFile(path.join(setup.workspace, 'multi-b.txt'), 'utf8'),
    ).toBe('multi b')
    const page = await setup.target.fileChanges.list(sessionId)
    expect(page.records).toHaveLength(2)
    const messages = await setup.target.sessions.listMessages(sessionId)
    expect(
      messages.records.filter((record) => record.kind === 'tool_result'),
    ).toHaveLength(2)
    const fileChangeCommits = topics
      .map((topic, index) => ({ topic, index }))
      .filter(({ topic }) => topic === 'file-change.changed')
    expect(fileChangeCommits).toHaveLength(2)
    const finalFileChangeCommit = fileChangeCommits.at(-1)!.index
    expect(topics.slice(finalFileChangeCommit + 1)).toContain('session.changed')
  })

  it.each([
    {
      label: 'patch',
      provider: () =>
        new FileMutationProvider('apply_patch', {
          path: 'restart.txt',
          patch: '@@ -1 +1 @@\n-before\n+after',
        }),
      before: 'before\n',
      after: 'after\n',
      permissionMode: 'auto' as const,
    },
    {
      label: 'delete',
      provider: () =>
        new FileMutationProvider('delete_file', {
          path: 'restart.txt',
        }),
      before: 'delete me\n',
      after: null,
      permissionMode: 'yolo' as const,
    },
  ])(
    'reopens and reverts a durable $label mutation',
    async ({ provider, before, after, permissionMode }) => {
      const setup = await setupTarget(provider())
      if (permissionMode === 'yolo') {
        await setup.store.update({
          version: 1,
          kind: 'privacy',
          yoloNoticeAccepted: {
            version: YOLO_NOTICE_VERSION,
            acceptedAt: new Date().toISOString(),
          },
        })
      }
      await writeFile(path.join(setup.workspace, 'restart.txt'), before)
      const sessionId = `session:durable-file-${permissionMode}` as SessionId
      const runId = await startFileRun(setup, sessionId, permissionMode)
      await setup.target.runtime.services.sessions.waitForRunSettled(
        sessionId,
        runId,
      )
      expect(
        await readFile(path.join(setup.workspace, 'restart.txt'), 'utf8').catch(
          () => null,
        ),
      ).toBe(after)

      await setup.target.dispose()
      const reopened = await createBackendForTest({
        configStore: setup.store,
        promptDirectory: path.resolve('resources', 'prompts'),
        targetDirectory: setup.targetDirectory,
        providerFactory: () => setup.provider,
      })
      try {
        const page = await reopened.fileChanges.list(sessionId)
        expect(page.records).toHaveLength(1)
        await reopened.fileChanges.revert(
          sessionId,
          page.records[0]!.id,
          page.records[0]!.revision,
        )
        expect(
          await readFile(path.join(setup.workspace, 'restart.txt'), 'utf8'),
        ).toBe(before)
      } finally {
        await reopened.dispose()
      }
    },
  )
})

async function setupTarget(provider: FileMutationProvider): Promise<{
  root: string
  workspace: string
  targetDirectory: string
  store: Awaited<ReturnType<typeof createConfig>>
  provider: FileMutationProvider
  target: DurableTargetRuntime
  projectId: Parameters<DurableTargetRuntime['projects']['get']>[0]
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-p5-runtime-'))
  const workspace = path.join(root, 'workspace')
  const targetDirectory = path.join(root, 'target')
  await mkdir(workspace)
  const store = await createConfig(root)
  const target = await createBackendForTest({
    configStore: store,
    promptDirectory: path.resolve('resources', 'prompts'),
    targetDirectory,
    providerFactory: () => provider,
  })
  cleanup.push(async () => {
    await target.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const projectId = (await target.projects.add({ path: workspace })).commit
    .change.projects[0]!.id
  return {
    root,
    workspace,
    targetDirectory,
    store,
    provider,
    target,
    projectId,
  }
}

async function startFileRun(
  setup: Awaited<ReturnType<typeof setupTarget>>,
  sessionId: SessionId,
  permissionMode: 'auto' | 'yolo' = 'auto',
) {
  const provider = setup.store.getPublicConfig().providers[0]!
  const started = await setup.target.runs.start({
    version: 1,
    kind: 'new_session',
    sessionId,
    projectId: setup.projectId,
    permissionMode,
    modelSelection: {
      providerId: provider.id,
      model: provider.model,
      reasoning: provider.reasoning,
    },
    message: 'Apply the requested file mutation',
    clientRequestId: `request:${sessionId}`,
  })
  if (started.outcome !== 'started') {
    throw new Error('File mutation Run did not start')
  }
  return started.runId
}
