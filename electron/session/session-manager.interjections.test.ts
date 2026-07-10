import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { SessionManager } from './session-manager'
import {
  FinalAnswerInterjectionProvider,
  InterjectionProvider,
} from './session-manager-interjection-fixtures'
import { createConfig, waitFor } from './session-manager-test-support'

describe('SessionManager live interjections', () => {
  it('injects a queued interjection after a tool batch without canceling the run', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-interject-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'notes.md'), 'note body\n')
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-interject-base',
    })

    // Wait for the first provider turn (tool call) to be consumed.
    await provider.firstTurnConsumed.promise

    const accepted = manager.interjectRun({
      sessionId,
      runId,
      message: 'Remember to quote the note verbatim',
      clientRequestId: 'request-interject-1',
    })
    expect(accepted).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // The run was not canceled: a second provider call happened.
    expect(provider.calls).toBe(2)
    // An interjection.updated event with status queued was emitted.
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'queued',
      ),
    ).toBe(true)
    // An interjection.updated event with status injected was emitted.
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'injected',
      ),
    ).toBe(true)

    const secondRequest = provider.requests[1]
    const secondRequestText = JSON.stringify(secondRequest)
    expect(secondRequestText).toContain('<live_user_interjection>')
    expect(secondRequestText).toContain('Remember to quote the note verbatim')
    // The interjection is a user message that follows the tool result, not
    // interleaved between the assistant tool_call and its tool_result.
    const secondMessages = secondRequest
    const toolResultIndex = secondMessages.findIndex(
      (message) => message.role === 'tool',
    )
    const interjectionIndex = secondMessages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<live_user_interjection>'),
    )
    expect(toolResultIndex).toBeGreaterThanOrEqual(0)
    expect(interjectionIndex).toBeGreaterThan(toolResultIndex)

    await manager.closeSession(sessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('interjection.message')
    expect(trace).toContain('"status":"queued"')
    expect(trace).toContain('"status":"injected"')
  })

  it('treats a repeated clientRequestId as a no-op even after the interjection is injected', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-idem-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'notes.md'), 'note body\n')
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-idem-base',
    })

    await provider.firstTurnConsumed.promise

    manager.interjectRun({
      sessionId,
      runId,
      message: 'queued once',
      clientRequestId: 'request-idem-1',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'injected',
      ),
    )

    // Retry the same clientRequestId after injection: accepted but must not
    // re-queue, re-emit or re-inject.
    const accepted = manager.interjectRun({
      sessionId,
      runId,
      message: 'queued once',
      clientRequestId: 'request-idem-1',
    })
    expect(accepted).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // Exactly one queued and one injected event for this interjection id.
    const queuedCount = sent.filter(
      (envelope) =>
        envelope.event.type === 'interjection.updated' &&
        envelope.event.status === 'queued',
    ).length
    const injectedCount = sent.filter(
      (envelope) =>
        envelope.event.type === 'interjection.updated' &&
        envelope.event.status === 'injected',
    ).length
    expect(queuedCount).toBe(1)
    expect(injectedCount).toBe(1)

    // The second provider request contains the injected content exactly once
    // (the retry did not re-inject). Count the user content, not the tag,
    // because the tag also appears in the rule note.
    const secondRequestText = JSON.stringify(provider.requests[1])
    const contentCount = secondRequestText.split('queued once').length - 1
    expect(contentCount).toBe(1)
    await manager.closeSession(sessionId)
  })

  it('carries over a pending interjection as the next ordinary user turn when the model reached a final answer', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-final-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new FinalAnswerInterjectionProvider()
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
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Answer now',
      clientRequestId: 'request-final-base',
    })

    // Wait for the model's first answer text to stream, then queue the
    // interjection before releasing the provider gate so the run loop sees
    // the pending interjection at the no-tool-calls branch.
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.text.delta' &&
          envelope.event.delta === 'Initial final answer',
      ),
    )

    manager.interjectRun({
      sessionId,
      runId,
      message: 'Actually also mention the interjection',
      clientRequestId: 'request-final-interject',
    })
    provider.firstTurnGate.resolve()

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // The run ended after the first final answer instead of forcing an extra
    // continuation that would overwrite it.
    expect(provider.calls).toBe(1)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.message.completed' &&
          envelope.event.text === 'Initial final answer',
      ),
    ).toBe(true)
    // The pending interjection was carried over as the next user turn.
    const carryover = sent.find(
      (envelope) => envelope.event.type === 'interjection.carryover',
    )?.event
    expect(carryover).toMatchObject({
      type: 'interjection.carryover',
      content: 'Actually also mention the interjection',
    })

    const nextRunId = manager.startRun({
      sessionId,
      message: 'Actually also mention the interjection',
      clientRequestId: 'request-final-carryover-next',
    })
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === nextRunId &&
          envelope.event.status === 'completed',
      ),
    )
    expect(provider.calls).toBe(2)
    expect(
      JSON.stringify(provider.requests[1]).includes(
        'Actually also mention the interjection',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('"status":"carryover"')
    expect(trace).toContain('Actually also mention the interjection')
  })

  it('supersedes pending interjections when the run is interrupted', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-stop-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-stop-base',
    })

    await provider.firstTurnConsumed.promise

    manager.interjectRun({
      sessionId,
      runId,
      message: 'queued but will be superseded',
      clientRequestId: 'request-stop-interject',
    })
    manager.interruptRun(sessionId, runId)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'cancelled',
      ),
    )

    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'superseded',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })
})
