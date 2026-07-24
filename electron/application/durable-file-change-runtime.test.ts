import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { createConfig } from '../session/session-manager-test-support'
import {
  createDurableTargetRuntime,
  type DurableTargetRuntime,
} from './create-durable-target-runtime'

class FileMutationProvider implements LLMProvider {
  calls = 0
  readonly requests: ProviderChatRequest['messages'][] = []

  constructor(
    readonly toolId: 'create_file' | 'apply_patch',
    readonly args: Record<string, string>,
  ) {}

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))
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

    const legacy = JSON.parse(
      await readFile(
        path.join(setup.targetDirectory, 'change-history.json'),
        'utf8',
      ),
    ) as { records: unknown[] }
    expect(legacy.records).toEqual([])
    expect(JSON.stringify(page)).not.toContain('beforeContent')
    expect(JSON.stringify(messages)).not.toContain('beforeContent')
  })
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
  let target: DurableTargetRuntime | undefined
  cleanup.push(async () => {
    await target?.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const workspace = path.join(root, 'workspace')
  const targetDirectory = path.join(root, 'target')
  await mkdir(workspace)
  const store = await createConfig(root)
  target = await createDurableTargetRuntime({
    configStore: store,
    promptDirectory: path.resolve('resources', 'prompts'),
    targetDirectory,
    providerFactory: () => provider,
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
) {
  const provider = setup.store.getPublicConfig().providers[0]!
  const started = await setup.target.runs.start({
    version: 1,
    kind: 'new_session',
    sessionId,
    projectId: setup.projectId,
    permissionMode: 'auto',
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
