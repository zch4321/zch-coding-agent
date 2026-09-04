import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
} from '../providers/provider-test-harness'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager plan tool batches', () => {
  class SameBatchPlanMutationProvider extends ScriptedProviderHarness {
    calls = 0

    async *run(): AsyncIterable<ProviderEvent> {
      this.calls += 1

      if (this.calls === 1) {
        const planArgs = { items: ['Create planned file'] }
        const writeArgs = { path: 'planned.txt', content: 'planned\n' }
        const toolCalls = [
          {
            id: 'call-plan-set',
            type: 'function',
            function: {
              name: 'plan_set',
              arguments: JSON.stringify(planArgs),
            },
          },
          {
            id: 'call-create-file',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify(writeArgs),
            },
          },
        ]
        yield {
          type: 'completed',
          rawResponse: { id: 'plan-and-write' },
          turn: { role: 'assistant', content: null, tool_calls: toolCalls },
          toolCalls: [
            {
              id: 'call-plan-set' as CallId,
              toolId: 'plan_set',
              args: planArgs,
              reason: 'Create a reviewable plan',
            },
            {
              id: 'call-create-file' as CallId,
              toolId: 'write_file',
              args: writeArgs,
              reason: 'Create the requested file',
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
        rawResponse: { id: 'plan-and-write-final' },
        turn: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
    }
  }

  it('keeps same-batch side-effect tools on the normal approval path after plan_set', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-plan-side-effect-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new SameBatchPlanMutationProvider()
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
      mode: 'confirm',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Plan, then create the file',
      clientRequestId: 'request-plan-side-effect',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'plan.updated' &&
          envelope.event.plan?.status === 'awaiting_review',
      ),
    )
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.callId === 'call-create-file',
      ),
    )

    expect(provider.calls).toBe(1)
    expect(
      await readFile(path.join(workspace, 'planned.txt'), 'utf8').catch(
        () => 'missing',
      ),
    ).toBe('missing')
    expect(manager.interruptRun(sessionId, runId)).toBe(true)
    await manager.closeSession(sessionId)
  })
})
