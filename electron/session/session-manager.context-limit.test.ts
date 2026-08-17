import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { MessageHistoryCompiler } from './canonical-history'
import { SessionManager } from './session-manager'
import { ContextLimitProvider } from './session-manager-compaction-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'
import type { SessionExecutionStatePort, SessionState } from './session-types'

describe('SessionManager context-limit boundary', () => {
  it.each([1, 2])(
    'sends and executes a Provider-accepted %i-call Tool batch despite local estimates',
    async (toolCallCount) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'agent-tool-context-limit-'),
      )
      const workspace = path.join(directory, 'workspace')
      await mkdir(workspace)
      const store = await createConfig(directory)
      const current = store.getPublicConfig()
      await store.update({
        version: 1,
        kind: 'provider-settings',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        contextWindowTokens: 2_048,
        compactThresholdTokens: 1_024,
        maxOutputTokens: 1_024,
        limits: {
          ...current.limits,
          tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
        },
      })
      const provider = new ContextLimitProvider(toolCallCount)
      const sent: AgentEventEnvelope[] = []
      let liveSession: SessionState | undefined
      const commitReasons: string[] = []
      const executionState: SessionExecutionStatePort = {
        async commit(session, input) {
          liveSession = session
          commitReasons.push(input.reason)
          return undefined
        },
      }
      const manager = new SessionManager({
        configStore: store,
        traceDirectory: path.join(directory, 'traces'),
        eventSink: createIpcTestEventSink((event) => sent.push(event)),
        providerFactory: () => provider,
        executionState,
      })
      const sessionId = await manager.createSession({
        workspace,
        mode: 'readonly',
        provider: 'deepseek',
      })
      const runId = manager.startRun({
        sessionId,
        message: 'Propose tools at the reported context limit.',
        clientRequestId: `request:tool-context-limit-${toolCallCount}`,
      })
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === runId &&
            event.status === 'completed',
        ),
      )
      await waitFor(() => !manager.hasActiveRun(sessionId))

      expect(provider.calls).toBe(3)
      expect(commitReasons).toContain('assistant_turn')
      expect(commitReasons).toContain('tool_batch')
      expect(commitReasons).toContain('compact')
      expect(
        sent.filter(
          ({ event }) =>
            event.type === 'tool.proposed' && event.runId === runId,
        ),
      ).toHaveLength(toolCallCount)
      expect(
        liveSession?.history.some(
          (record) =>
            record.kind === 'assistant_turn' &&
            record.parts.some(
              (part) =>
                part.type === 'tool_call' &&
                part.callId.startsWith('call:context-limit-'),
            ),
        ),
      ).toBe(true)
      expect(
        liveSession?.history.filter((record) => record.kind === 'tool_result'),
      ).toHaveLength(toolCallCount)
      expect(
        liveSession?.history.some(
          (record) => record.kind === 'compact_summary',
        ),
      ).toBe(true)
      expect(() =>
        new MessageHistoryCompiler().compile(liveSession?.history ?? []),
      ).not.toThrow()
      await manager.closeSession(sessionId)
    },
    10_000,
  )
})
