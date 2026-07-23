import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
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
})
