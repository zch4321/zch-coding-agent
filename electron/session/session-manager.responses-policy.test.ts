import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { MessageRecord } from '../../shared/message'
import { GenericResponsesProvider } from '../providers/generic-responses-provider'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

describe('Responses policy stops in Session runtime', () => {
  it.each(['http', 'stream'])(
    'stops %s policy failures without retrying or committing assistant output',
    async (mode) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'responses-policy-test-'),
      )
      const workspace = path.join(directory, 'workspace')
      await mkdir(workspace)
      const events: AgentEventEnvelope[] = []
      const histories: MessageRecord[][] = []
      const fetchImpl = vi.fn(async () =>
        mode === 'http'
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'misalignment_policy_violation',
                  type: 'invalid_request_error',
                  message: 'private detail',
                },
              }),
              { status: 403 },
            )
          : new Response(
              [
                {
                  type: 'response.output_text.delta',
                  delta: 'partial commentary',
                },
                {
                  type: 'response.output_item.added',
                  output_index: 1,
                  item: {
                    type: 'function_call',
                    call_id: 'call:blocked',
                    name: 'write_file',
                    arguments: '',
                  },
                },
                {
                  type: 'response.function_call_arguments.delta',
                  output_index: 1,
                  delta: '{"path":"blocked.txt","content":"should not run"}',
                },
                {
                  type: 'response.failed',
                  response: {
                    id: 'resp_blocked',
                    status: 'failed',
                    error: { code: 'misalignment_policy_violation' },
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(''),
            ),
      )
      const configStore = await createConfig(directory)
      await configStore.update({
        version: 1,
        kind: 'provider-settings',
        providerId: 'deepseek',
        providerType: 'generic.responses',
        baseURL: 'https://api.example/v1',
        model: 'deepseek-v4-pro',
      })
      const manager = new SessionManager({
        configStore,
        traceDirectory: path.join(directory, 'traces'),
        eventSink: createIpcTestEventSink((event) => events.push(event)),
        providerFactory: () =>
          new GenericResponsesProvider({
            providerId: 'deepseek',
            baseURL: 'https://api.example/v1',
            apiKey: 'secret-sentinel',
            fetchImpl,
          }),
        executionState: {
          commit: async (session) => {
            histories.push(structuredClone(session.history))
            return undefined
          },
        },
      })
      try {
        const sessionId = await manager.createSession({
          workspace,
          mode: 'yolo',
          provider: 'deepseek',
        })
        const runId = manager.startRun({
          sessionId,
          message: 'Inspect this workspace',
          clientRequestId: `request:policy:${mode}`,
        })
        await waitFor(() =>
          events.some(
            ({ event }) =>
              event.type === 'run.status' &&
              event.runId === runId &&
              event.status === 'failed',
          ),
        )
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(
          events.some(({ event }) => event.type === 'provider.retrying'),
        ).toBe(false)
        expect(events.some(({ event }) => event.type === 'tool.proposed')).toBe(
          false,
        )
        expect(
          events.some(
            ({ event }) => event.type === 'assistant.message.completed',
          ),
        ).toBe(false)
        const status = events.find(
          ({ event }) =>
            event.type === 'run.status' && event.status === 'failed',
        )?.event
        const failure = status?.type === 'run.status' ? status.error : undefined
        expect(failure).toMatchObject({
          code: 'PROVIDER_POLICY_BLOCKED',
          message: expect.stringContaining('misalignment_policy_violation'),
        })
        expect(JSON.stringify(failure)).not.toContain('private detail')
        expect(
          histories.flat().some((record) => record.kind === 'assistant_turn'),
        ).toBe(false)
      } finally {
        await manager.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
