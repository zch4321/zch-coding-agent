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
    'does not persist or execute a %i-call Tool batch at the hard limit',
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
        reasoning: 'off',
        contextWindowTokens: 160_000,
        compactThresholdTokens: 100_000,
        maxOutputTokens: 8_000,
        limits: current.limits,
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
      const failedRunId = manager.startRun({
        sessionId,
        message: 'Propose tools at the reported context limit.',
        clientRequestId: `request:tool-context-limit-${toolCallCount}`,
      })
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === failedRunId &&
            event.status === 'failed',
        ),
      )
      await waitFor(() => !manager.hasActiveRun(sessionId))

      expect(provider.calls).toBe(1)
      expect(commitReasons).not.toContain('assistant_turn')
      expect(commitReasons).not.toContain('tool_batch')
      expect(
        sent.some(
          ({ event }) =>
            event.type === 'tool.proposed' && event.runId === failedRunId,
        ),
      ).toBe(false)
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
      ).toBe(false)
      expect(() =>
        new MessageHistoryCompiler().compile(liveSession?.history ?? []),
      ).not.toThrow()

      const recoveredRunId = manager.startRun({
        sessionId,
        message: 'Continue from the last complete history boundary.',
        clientRequestId: `request:tool-context-recovered-${toolCallCount}`,
      })
      await waitFor(() =>
        sent.some(
          ({ event }) =>
            event.type === 'run.status' &&
            event.runId === recoveredRunId &&
            event.status === 'completed',
        ),
      )
      expect(provider.calls).toBe(2)
      await manager.closeSession(sessionId)
    },
    10_000,
  )
})
