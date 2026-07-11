import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { ScriptedEditProvider } from '../session/session-manager-approval-fixtures'
import { createConfig } from '../session/session-manager-test-support'
import { createAgentRuntime } from './create-agent-runtime'

describe('AgentRuntime Node boundary', () => {
  it('runs and disposes without BrowserWindow, WebContents, preload, or IPC', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'note.txt'), 'alpha\nbeta\n')
    const configStore = await createConfig(directory)
    const events: AgentEvent[] = []
    const provider = new ScriptedEditProvider()
    const runtime = await createAgentRuntime({
      configStore,
      userDataDirectory: directory,
      promptDirectory: path.resolve('resources', 'prompts'),
      providerFactory: () => provider,
      eventListeners: [{ onAgentEvent: (event) => events.push(event) }],
    })

    const sessionId = await runtime.createSession({
      workspace,
      mode: 'yolo',
      provider: configStore.getPublicConfig().activeProviderId,
    })
    const handle = runtime.run({
      sessionId,
      message: 'Update note.txt as requested.',
      clientRequestId: 'runtime-node-boundary',
    })

    await expect(handle.completion).resolves.toMatchObject({
      sessionId,
      runId: handle.runId,
      status: 'completed',
    })
    expect(await readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe(
      'alpha\ngamma\n',
    )
    expect(
      events.some(
        (event) =>
          event.type === 'tool.proposed' && event.tool === 'apply_patch',
      ),
    ).toBe(true)

    await runtime.dispose()
    await runtime.dispose()
    await expect(runtime.services.traces.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ closed: true })]),
    )
    expect(() =>
      runtime.run({
        sessionId,
        message: 'Do not run.',
        clientRequestId: 'after-dispose',
      }),
    ).toThrow('disposing')
  })

  it('connects the caller abort signal to the shared run cancellation path', async () => {
    class BlockingProvider implements LLMProvider {
      async *streamChat(
        request: ProviderChatRequest,
      ): AsyncIterable<ProviderEvent> {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(request.signal.reason)
          request.signal.addEventListener('abort', abort, { once: true })
        })
        yield {
          type: 'completed',
          rawResponse: {},
          turn: { role: 'assistant', content: 'Unexpected completion' },
          toolCalls: [],
          usage: {},
          providerState: {},
          timing: {},
        }
      }
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const runtime = await createAgentRuntime({
      configStore,
      userDataDirectory: directory,
      promptDirectory: path.resolve('resources', 'prompts'),
      providerFactory: () => new BlockingProvider(),
    })
    const sessionId = await runtime.createSession({
      workspace,
      mode: 'yolo',
      provider: configStore.getPublicConfig().activeProviderId,
    })
    const controller = new AbortController()
    const handle = runtime.run({
      sessionId,
      message: 'Wait until interrupted.',
      clientRequestId: 'runtime-abort',
      signal: controller.signal,
    })

    controller.abort(new Error('test abort'))
    await expect(handle.completion).resolves.toMatchObject({
      status: 'cancelled',
    })
    await runtime.dispose()
  })
})
