import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { DEFAULT_ORCHESTRATION_PROMPT_REFS } from '../../shared/prompt-resources'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  GoalContinuationProvider,
  PlanCompletionProvider,
  PlanWarningProvider,
} from './session-manager-orchestration-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  parseTrace,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager goal and plan orchestration', () => {
  it('continues an active Goal until the model explicitly completes it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-goal-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new GoalContinuationProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/goal Produce a verified result',
      clientRequestId: 'request-goal',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(3)
    const firstRequest =
      provider.requests[0]
        ?.map((message) =>
          typeof message.content === 'string' ? message.content : '',
        )
        .join('\n') ?? ''
    expect(firstRequest).toContain(
      '<orchestration_request kind="goal-started">',
    )
    expect(firstRequest).toContain('Produce a verified result')
    expect(firstRequest).toContain('goal_complete')
    expect(
      sent.find(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'goal-started',
      )?.event,
    ).toMatchObject({
      promptId: DEFAULT_ORCHESTRATION_PROMPT_REFS.goalStarted['zh-CN'].id,
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'goal-continuation',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'goal.updated' &&
          envelope.event.goal?.status === 'completed',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('does not auto-continue a Plan awaiting review', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new PlanWarningProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/plan Check something',
      clientRequestId: 'request-plan',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(2)
    const firstRequest =
      provider.requests[0]
        ?.map((message) =>
          typeof message.content === 'string' ? message.content : '',
        )
        .join('\n') ?? ''
    expect(firstRequest).toContain(
      '<orchestration_request kind="plan-started">',
    )
    expect(firstRequest).toContain('Check something')
    expect(firstRequest).toContain('plan_set')
    expect(
      sent.find(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-started',
      )?.event,
    ).toMatchObject({
      promptId: DEFAULT_ORCHESTRATION_PROMPT_REFS.planStarted['zh-CN'].id,
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'plan.updated' &&
          envelope.event.plan?.status === 'awaiting_review',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-continuation',
      ),
    ).toBe(false)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-warning',
      ),
    ).toBe(false)
    await expect(
      manager.updatePlanStatus({ sessionId, status: 'rejected' }),
    ).resolves.toMatchObject({
      accepted: true,
      plan: { status: 'rejected' },
    })
    const trace = parseTrace(
      await readFile(
        path.join(directory, 'traces', `${sessionId}.jsonl`),
        'utf8',
      ),
    )
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'plan.status',
          previousStatus: 'awaiting_review',
          status: 'rejected',
          source: 'ui:plan-review',
        }),
      ]),
    )
    await manager.closeSession(sessionId)
  })

  it('marks an active Plan completed when every item is closed', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-plan-complete-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new PlanCompletionProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/plan Check something',
      clientRequestId: 'request-plan-complete',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(4)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'plan.updated' &&
          envelope.event.plan?.status === 'completed',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-warning',
      ),
    ).toBe(false)
    await manager.closeSession(sessionId)
  })

  it('auto-continues an active standalone Plan once and then warns', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new PlanWarningProvider(true)
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/plan Check something',
      clientRequestId: 'request-plan',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(4)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-continuation',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-warning',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })
})
