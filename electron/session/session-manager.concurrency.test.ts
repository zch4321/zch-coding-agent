import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { PromptRegistry } from '../prompts/registry'
import { ProjectMetadataStore } from '../project/project-metadata-store'
import { SessionManager } from './session-manager'
import { createConfig, waitFor } from './session-manager-test-support'

describe('SessionManager M1 workspace concurrency', () => {
  class ConcurrentGateProvider implements LLMProvider {
    readonly requests: ProviderChatRequest['messages'][] = []
    readonly #releases: Array<() => void> = []

    async *streamChat(
      request: ProviderChatRequest,
    ): AsyncIterable<ProviderEvent> {
      const index = this.requests.length
      this.requests.push(structuredClone(request.messages))
      await new Promise<void>((resolve) => {
        this.#releases[index] = resolve
      })
      yield {
        type: 'completed',
        rawResponse: { id: `concurrent-${index}` },
        turn: { role: 'assistant', content: `completed-${index}` },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }

    release(index: number): void {
      this.#releases[index]?.()
    }

    requestContaining(
      text: string,
    ): ProviderChatRequest['messages'] | undefined {
      return this.requests.find((messages) =>
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes(text),
        ),
      )
    }

    releaseRequestContaining(text: string): void {
      const index = this.requests.findIndex((messages) =>
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes(text),
        ),
      )
      if (index < 0) throw new Error(`Provider request not found: ${text}`)
      this.release(index)
    }
  }

  class NonAbortableMetadataProvider implements LLMProvider {
    calls = 0

    async *streamChat(): AsyncIterable<ProviderEvent> {
      this.calls += 1

      if (this.calls === 1) {
        const args = {
          modules: [{ root: '.', languages: ['typescript'] }],
        }
        yield {
          type: 'completed',
          rawResponse: { id: 'non-abortable-metadata-write' },
          turn: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call:non-abortable-metadata',
                type: 'function',
                function: {
                  name: 'project_set_modules',
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
          toolCalls: [
            {
              id: 'call:non-abortable-metadata' as CallId,
              toolId: 'project_set_modules',
              args,
              reason: 'Persist discovered workspace modules',
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
        rawResponse: { id: 'second-writer' },
        turn: { role: 'assistant', content: 'Second writer completed' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }

  function lastWorkspaceConcurrency(
    messages: ProviderChatRequest['messages'],
  ): string {
    return (
      messages
        .filter(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('<workspace_concurrency'),
        )
        .at(-1)?.content ?? ''
    )
  }
  it('enforces four active runs and one writer per canonical workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-m1-'))
    const workspaceA = path.join(directory, 'workspace-a')
    const workspaceB = path.join(directory, 'workspace-b')
    const workspaceC = path.join(directory, 'workspace-c')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(workspaceC)])
    const store = await createConfig(directory)
    const provider = new ConcurrentGateProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const writerSession = await manager.createSession({
      conversationId: 'conversation:writer-a',
      workspace: workspaceA,
      mode: 'auto',
      provider: 'deepseek',
    })
    const readerSession = await manager.createSession({
      conversationId: 'conversation:reader-a',
      workspace: workspaceA,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const otherWriterSession = await manager.createSession({
      conversationId: 'conversation:writer-b',
      workspace: workspaceB,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const otherReaderSession = await manager.createSession({
      conversationId: 'conversation:reader-b',
      workspace: workspaceB,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const fifthSession = await manager.createSession({
      conversationId: 'conversation:fifth',
      workspace: workspaceC,
      mode: 'readonly',
      provider: 'deepseek',
    })

    const writerRun = manager.startRun({
      sessionId: writerSession,
      message: 'Hold writer A',
      clientRequestId: 'm1-writer-a',
    })
    await waitFor(() => provider.requests.length === 1)
    expect(
      lastWorkspaceConcurrency(provider.requestContaining('Hold writer A')!),
    ).toContain('status="writer"')
    expect(
      sent.some(
        ({ event }) =>
          event.type === 'workspace.writer.changed' &&
          event.status === 'acquired' &&
          event.writerRunId === writerRun,
      ),
    ).toBe(true)

    await expect(
      manager.updateSessionMode(readerSession, 'confirm'),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'workspace_writer_active',
      writerConversationId: 'conversation:writer-a',
      writerRunId: writerRun,
    })
    expect(() =>
      manager.startRun({
        sessionId: readerSession,
        message: 'Must not write concurrently',
        clientRequestId: 'm1-rejected-writer',
      }),
    ).toThrow('Another run is modifying this workspace')

    await expect(
      manager.updateSessionMode(readerSession, 'readonly'),
    ).resolves.toEqual({ accepted: true })
    const readerRun = manager.startRun({
      sessionId: readerSession,
      message: 'Read while writer A is active',
      clientRequestId: 'm1-reader-a',
    })
    const otherWriterRun = manager.startRun({
      sessionId: otherWriterSession,
      message: 'Hold writer B',
      clientRequestId: 'm1-writer-b',
    })
    const otherReaderRun = manager.startRun({
      sessionId: otherReaderSession,
      message: 'Read workspace B',
      clientRequestId: 'm1-reader-b',
    })
    await waitFor(() => provider.requests.length === 4)
    const readerARequest = provider.requestContaining(
      'Read while writer A is active',
    )!
    expect(lastWorkspaceConcurrency(readerARequest)).toContain(
      'status="readonly_locked"',
    )
    expect(lastWorkspaceConcurrency(readerARequest)).toContain(
      'conversation:writer-a',
    )
    expect(
      lastWorkspaceConcurrency(provider.requestContaining('Hold writer B')!),
    ).toContain('status="writer"')

    expect(() =>
      manager.startRun({
        sessionId: fifthSession,
        message: 'Fifth run',
        clientRequestId: 'm1-fifth',
      }),
    ).toThrow('maximum number of concurrent runs')

    for (const message of [
      'Hold writer A',
      'Read while writer A is active',
      'Hold writer B',
      'Read workspace B',
    ]) {
      provider.releaseRequestContaining(message)
    }
    const initialRuns = [writerRun, readerRun, otherWriterRun, otherReaderRun]
    await waitFor(() =>
      initialRuns.every((runId) =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === runId &&
            event.status === 'completed',
        ),
      ),
    )

    const availableRun = manager.startRun({
      sessionId: readerSession,
      message: 'Read after writers released',
      clientRequestId: 'm1-reader-available',
    })
    await waitFor(() => provider.requests.length === 5)
    expect(
      lastWorkspaceConcurrency(
        provider.requestContaining('Read after writers released')!,
      ),
    ).toContain('status="available"')
    provider.releaseRequestContaining('Read after writers released')
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === availableRun &&
          event.status === 'completed',
      ),
    )

    await expect(
      manager.updateSessionMode(readerSession, 'confirm'),
    ).resolves.toEqual({ accepted: true })
    const nextWriterRun = manager.startRun({
      sessionId: readerSession,
      message: 'Writer after release',
      clientRequestId: 'm1-next-writer',
    })
    await waitFor(() => provider.requests.length === 6)
    expect(
      lastWorkspaceConcurrency(
        provider.requestContaining('Writer after release')!,
      ),
    ).toContain('status="writer"')
    provider.releaseRequestContaining('Writer after release')
    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === nextWriterRun &&
          event.status === 'completed',
      ),
    )

    await manager.dispose()
    const trace = await readFile(
      path.join(directory, 'traces', `${readerSession}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('"type":"run.rejected"')
    expect(trace).toContain('"status":"rejected"')
    expect(trace).toContain('"status":"acquired"')
    expect(trace).toContain('"status":"released"')
  })

  it('keeps the writer lease while an aborted non-abortable metadata write is still running', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-m1-lease-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'logging',
      value: {
        ...store.getPublicConfig().logging,
        enabled: false,
      },
    })

    const projectMetadata = new ProjectMetadataStore()
    const snapshot = await projectMetadata.get(workspace)
    let markSaveStarted!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve
    })
    let allowSaveToFinish!: () => void
    const saveMayFinish = new Promise<void>((resolve) => {
      allowSaveToFinish = resolve
    })
    let saveFinished = false
    vi.spyOn(projectMetadata, 'save').mockImplementation(async () => {
      markSaveStarted()
      await saveMayFinish
      saveFinished = true
      return snapshot
    })

    const provider = new NonAbortableMetadataProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
      projectMetadata,
    })
    const writerSession = await manager.createSession({
      conversationId: 'conversation:non-abortable-writer',
      workspace,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const contenderSession = await manager.createSession({
      conversationId: 'conversation:lease-contender',
      workspace,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const writerRun = manager.startRun({
      sessionId: writerSession,
      message: 'Persist the workspace module metadata',
      clientRequestId: 'non-abortable-writer',
    })

    try {
      await saveStarted
      expect(manager.interruptRun(writerSession, writerRun)).toBe(true)
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === writerRun &&
            event.status === 'cancelled',
        ),
      )
      expect(saveFinished).toBe(false)

      expect(() =>
        manager.startRun({
          sessionId: contenderSession,
          message: 'Start another workspace writer',
          clientRequestId: 'lease-contender',
        }),
      ).toThrow('Another run is modifying this workspace')

      allowSaveToFinish()
      await waitFor(() => saveFinished)
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'workspace.writer.changed' &&
            event.status === 'released' &&
            event.writerRunId === writerRun,
        ),
      )

      const contenderRun = manager.startRun({
        sessionId: contenderSession,
        message: 'Start another workspace writer',
        clientRequestId: 'lease-contender-after-settlement',
      })
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === contenderRun &&
            event.status === 'completed',
        ),
      )
    } finally {
      allowSaveToFinish()
      await manager.dispose()
    }
  })
})
