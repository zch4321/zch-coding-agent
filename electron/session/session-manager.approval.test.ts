import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { SessionManager } from './session-manager'
import {
  safeAutoApprover,
  ScriptedCommandProvider,
  ScriptedEditProvider,
  sseResponse,
} from './session-manager-approval-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager approvals', () => {
  it('completes an Auto edit through policy approval and records change evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-p3-'))
    const workspace = path.join(directory, 'workspace')
    const target = path.join(workspace, 'note.txt')
    await mkdir(workspace)
    await writeFile(target, 'alpha\nbeta\n')

    const store = await createConfig(directory)
    const provider = new ScriptedEditProvider()
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
      autoApproverFactory: () => safeAutoApprover,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Change beta to gamma in note.txt',
      clientRequestId: 'request-p3-edit',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(await readFile(target, 'utf8')).toBe('alpha\ngamma\n')
    expect(
      sent.find(
        (envelope) =>
          envelope.event.type === 'tool.completed' &&
          envelope.event.callId === 'call-edit',
      )?.event,
    ).not.toHaveProperty('approval')
    await manager.closeSession(sessionId)
    const trace = (
      await readFile(
        path.join(directory, 'traces', `${sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const toolCall = trace.find((event) => event.type === 'tool.call')
    const toolAttempt = trace.find((event) => event.type === 'tool.attempt')

    expect(toolAttempt).toMatchObject({
      tool: 'apply_patch',
      stage: 'execution',
      outcome: 'succeeded',
      effects: ['filesystem.write'],
    })
    expect(toolCall).toMatchObject({
      tool: 'apply_patch',
      approvedBy: 'policy',
    })
    expect(toolCall?.policySignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'filesystem_patch' }),
      ]),
    )
    expect(toolCall?.diffHash).toEqual(expect.any(String))
  })

  it('uses JSON mode and respects disabled reasoning for Auto approval requests', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-auto-approval-json-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)

    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'deepseek',
      label: 'DeepSeek',
      profile: 'deepseek',
      baseURL: 'https://api.example/v1',
      model: 'main-model',
      reasoning: 'off',
      approverProviderId: 'deepseek',
      approverModel: 'approval-model',
      limits: current.limits,
    })
    const provider = new ScriptedCommandProvider()
    const approvalBodies: JsonValue[] = []
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
      fetchImpl: async (_input, init) => {
        approvalBodies.push(JSON.parse(String(init?.body)) as JsonValue)
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'Check bounded command.',
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content:
                    '{"decision":"safe","note":"bounded process command"}',
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 6,
              total_tokens: 18,
            },
          },
        ])
      },
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Check the local Node version',
      clientRequestId: 'request-auto-approval-json',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(approvalBodies).toEqual([
      expect.objectContaining({
        model: 'approval-model',
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
    ])
    expect(approvalBodies[0]).not.toHaveProperty('reasoning_effort')
    await manager.closeSession(sessionId)
  })

  it('executes a command after Auto approval times out and the user approves', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-auto-approval-timeout-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)

    const store = await createConfig(directory)
    const provider = new ScriptedCommandProvider()
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
      autoApproverFactory: () => ({
        async evaluate() {
          return {
            decision: 'dangerous',
            note: 'Approval model timed out',
            valid: false,
            failure: 'timeout',
          }
        },
      }),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Check the local Node version',
      clientRequestId: 'request-auto-approval-timeout',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.callId === 'call-command',
      ),
    )

    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-command' as CallId,
        decision: 'allow',
      }),
    ).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    const completedTool = sent.find(
      (envelope) =>
        envelope.event.type === 'tool.completed' &&
        envelope.event.callId === 'call-command',
    )?.event

    expect(completedTool).toMatchObject({
      result: { status: 'ok' },
      approval: {
        approver: 'model',
        decision: 'dangerous',
        failure: 'timeout',
      },
    })
    expect(provider.requests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-command',
          content: expect.stringContaining('"status":"ok"'),
        }),
      ]),
    )
    await manager.closeSession(sessionId)
  })

  it('continues after a user denial with a terminal denied tool result', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-denied-command-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)

    const store = await createConfig(directory)
    const provider = new ScriptedCommandProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Check the local Node version',
      clientRequestId: 'request-denied-command',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.callId === 'call-command',
      ),
    )
    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-command' as CallId,
        decision: 'deny',
      }),
    ).toBe(true)
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === runId &&
          envelope.event.status === 'completed',
      ),
    )
    await manager.waitForRunSettled(sessionId, runId)

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-command',
          content: expect.stringContaining('"status":"denied"'),
        }),
      ]),
    )
    expect(
      sent.find(
        (envelope) =>
          envelope.event.type === 'tool.completed' &&
          envelope.event.callId === 'call-command',
      )?.event,
    ).toMatchObject({ result: { status: 'denied' } })
    await manager.closeSession(sessionId)
  })

  it('accepts one Confirm decision and persists a bounded remembered rule', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-confirm-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'note.txt'), 'alpha\nbeta\n')

    const store = await createConfig(directory)
    const provider = new ScriptedEditProvider()
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
    const otherSessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Change beta to gamma in note.txt',
      clientRequestId: 'request-confirm-edit',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.kind === 'tool',
      ),
    )
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()

    expect(
      manager.decideApproval({
        sessionId: otherSessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
      }),
    ).toBe(false)
    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
        remember: { workspaceScope: 'workspace', expiresAt },
      }),
    ).toBe(true)
    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
      }),
    ).toBe(false)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === runId &&
          envelope.event.status === 'completed',
      ),
    )

    expect(store.getPublicConfig().permission.rememberedRules).toEqual([
      expect.objectContaining({
        effect: 'allow',
        toolId: 'apply_patch',
        workspaceScope: path.resolve(await realpath(workspace)),
        argConstraints: { path: 'note.txt' },
        expiresAt,
        createdFromCallId: 'call-edit',
      }),
    ])
    await manager.closeSession(sessionId)
    await manager.closeSession(otherSessionId)
  })
})
