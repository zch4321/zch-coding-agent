import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId, EventId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  ForkProvider,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager cancellation and forks', () => {
  class MultiToolCancellationProvider implements LLMProvider {
    calls = 0
    requests: ProviderChatRequest['messages'][] = []

    async *streamChat(
      request: ProviderChatRequest,
    ): AsyncIterable<ProviderEvent> {
      this.calls += 1
      this.requests.push(structuredClone(request.messages))

      if (this.calls === 1) {
        const toolCalls = ['first.txt', 'second.txt'].map(
          (fileName, index) => ({
            id: `call-write-${index + 1}`,
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: fileName, content: fileName }),
            },
          }),
        )
        yield {
          type: 'completed',
          rawResponse: {},
          turn: { role: 'assistant', content: null, tool_calls: toolCalls },
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id as CallId,
            toolId: 'create_file',
            args: JSON.parse(toolCall.function.arguments) as JsonValue,
            reason: 'Create cancellation fixture',
          })),
          usage: {},
          providerState: {},
          timing: {},
        }
        return
      }

      yield {
        type: 'completed',
        rawResponse: {},
        turn: { role: 'assistant', content: 'Recovered after cancellation' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }

  it('fills every tool result when a multi-tool turn is interrupted', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-cancel-tools-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new MultiToolCancellationProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    } as WebContents
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) =>
        webContents.send('', envelope),
      ),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const firstRunId = manager.startRun({
      sessionId,
      message: 'Create both files',
      clientRequestId: 'request-cancel-tools',
    })

    await waitFor(() =>
      sent.some((envelope) => envelope.event.type === 'approval.requested'),
    )
    expect(manager.interruptRun(sessionId, firstRunId)).toBe(true)
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === firstRunId &&
          envelope.event.status === 'cancelled',
      ),
    )

    manager.startRun({
      sessionId,
      message: 'Continue safely',
      clientRequestId: 'request-after-cancel',
    })
    await waitFor(() => provider.calls === 2)

    expect(
      provider.requests[1]?.filter((message) => message.role === 'tool'),
    ).toHaveLength(2)
    expect(
      await readFile(path.join(workspace, 'first.txt'), 'utf8').catch(
        () => 'missing',
      ),
    ).toBe('missing')
    await manager.closeSession(sessionId)
  })

  it('forks recorded context without replaying historical side effects', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-fork-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const notePath = path.join(workspace, 'note.txt')
    await writeFile(notePath, 'unchanged\n')
    const store = await createConfig(directory)
    const provider = new ForkProvider()
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => provider,
    })
    const sourceEventId = 'event-source-request' as EventId
    const fork = await manager.createForkFromTrace({
      conversationId: 'conversation:fork-test',
      workspace,
      mode: 'confirm',
      sourceEventId,
      providerRequest: { model: 'recorded-model', temperature: 0.25 },
      messages: [
        { role: 'system', content: 'Recorded system prompt' },
        { role: 'user', content: 'Previously requested edit' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'historical-call',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'historical-call',
          content: '{"status":"ok"}',
        },
      ],
    })
    manager.startForkRun(fork.sessionId)

    await waitFor(() => provider.calls === 1)
    await manager.closeSession(fork.sessionId)
    expect(await readFile(notePath, 'utf8')).toBe('unchanged\n')
    expect(provider.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'historical-call',
        }),
      ]),
    )
    expect(provider.providerRequestOverride).toEqual({
      model: 'recorded-model',
      temperature: 0.25,
    })

    const trace = (
      await readFile(
        path.join(directory, 'traces', `${fork.sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(trace[0]).toMatchObject({
      type: 'session.start',
      forkedFromEventId: sourceEventId,
    })
  })
})
