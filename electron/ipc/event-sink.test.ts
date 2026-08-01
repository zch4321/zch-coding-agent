import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_EXECUTION_EVENT_CHANNEL,
  APP_NOTIFICATION_CHANNEL,
} from '../../shared/channels'
import type { AgentExecutionEventEnvelope } from '../../shared/ipc-contract'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { BackendNotificationEnvelope } from '../../shared/notifications'
import {
  sendAgentExecutionEvent,
  sendBackendNotification,
  sendDomainStateEvent,
} from './event-sink'

const validNotification: BackendNotificationEnvelope = {
  version: 1,
  id: 'notification:event-sink',
  severity: 'error',
  code: 'PERSISTENCE_FAILURE',
  message: 'The request failed.',
  occurredAt: '2026-07-26T00:00:00.000Z',
}

const validExecutionEvent: AgentExecutionEventEnvelope = {
  version: 1,
  event: {
    schemaVersion: 1,
    seq: 1,
    ts: '2026-07-26T00:00:00.000Z',
    type: 'run.status',
    executionId: 'subagent:event-sink' as AgentExecutionId,
    parentSessionId: 'session:event-sink' as SessionId,
    parentRunId: 'run:event-sink' as RunId,
    parentCallId: 'call:event-sink' as CallId,
    status: 'calling_llm',
  },
}

function webContents(destroyed = false): WebContents {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
  } as unknown as WebContents
}

describe('backend notification event sink', () => {
  it('validates and sends safe envelopes', () => {
    const target = webContents()
    sendBackendNotification(target, validNotification)
    expect(target.send).toHaveBeenCalledWith(
      APP_NOTIFICATION_CHANNEL,
      validNotification,
    )
  })

  it('rejects unknown diagnostic fields and skips destroyed windows', () => {
    expect(() =>
      sendBackendNotification(webContents(), {
        ...validNotification,
        stack: 'must not cross IPC',
      } as BackendNotificationEnvelope),
    ).toThrow()
    const destroyed = webContents(true)
    sendBackendNotification(destroyed, validNotification)
    expect(destroyed.send).not.toHaveBeenCalled()
  })

  it('rejects non-commit domain deliveries with a stable error', () => {
    expect(() =>
      sendDomainStateEvent(webContents(), { kind: 'buffer_overflow' }),
    ).toThrow('Domain-state renderer delivery only accepts commits')
  })

  it('sends execution events only on their private parent-scoped channel', () => {
    const target = webContents()
    sendAgentExecutionEvent(target, validExecutionEvent)
    expect(target.send).toHaveBeenCalledWith(
      AGENT_EXECUTION_EVENT_CHANNEL,
      validExecutionEvent,
    )
    expect(() =>
      sendAgentExecutionEvent(target, {
        ...validExecutionEvent,
        event: {
          ...validExecutionEvent.event,
          childSessionId: 'session:hidden-child',
        },
      } as unknown as AgentExecutionEventEnvelope),
    ).toThrow()
  })
})
