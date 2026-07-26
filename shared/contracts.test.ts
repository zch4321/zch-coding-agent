import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import {
  AgentEventSchema,
  TerminalEventSchema,
  type AgentEvent,
  type TerminalEvent,
} from './agent-events'
import { IPC_CONTRACTS, type IpcChannel, type IpcPayload } from './ipc-contract'
import type { CallId, RunId, SessionId, TerminalId } from './ids'
import {
  BackendNotificationEnvelopeSchema,
  type BackendNotificationEnvelope,
} from './notifications'

const sessionId = 'session-1' as SessionId
const runId = 'run-1' as RunId
const callId = 'call-1' as CallId
const terminalId = 'terminal-1' as TerminalId

function compileSchema(schema: object) {
  const ajv = new Ajv({ strict: true })
  ajv.addFormat('date-time', true)
  return ajv.compile(schema)
}

describe('shared runtime contracts', () => {
  it('bounds backend notifications and rejects diagnostic internals', () => {
    const validate = compileSchema(BackendNotificationEnvelopeSchema)
    const notification: BackendNotificationEnvelope = {
      version: 1,
      id: 'notification:fixture',
      severity: 'warning',
      code: 'BACKEND_DIAGNOSTIC',
      message: 'A background operation was degraded.',
      occurredAt: '2026-07-26T00:00:00.000Z',
      sessionId,
    }
    expect(validate(notification)).toBe(true)
    expect(validate({ ...notification, stack: 'secret stack' })).toBe(false)
    expect(validate({ ...notification, code: 'invalid-code' })).toBe(false)
    expect(validate({ ...notification, message: 'x'.repeat(1_025) })).toBe(
      false,
    )
  })

  it('validates representative AgentEvent and TerminalEvent values', () => {
    const validateAgentEvent = compileSchema(AgentEventSchema)
    const validateTerminalEvent = compileSchema(TerminalEventSchema)
    const agentEvent: AgentEvent = {
      schemaVersion: 1,
      type: 'tool.proposed',
      sessionId,
      runId,
      callId,
      tool: 'read_file',
      args: { path: 'README.md' },
      reason: '',
      seq: 1,
      ts: '2026-06-15T00:00:00.000Z',
    }
    const terminalEvent: TerminalEvent = {
      schemaVersion: 1,
      type: 'terminal.output',
      sessionId,
      terminalId,
      chunk: 'ready',
      seq: 1,
      ts: '2026-06-15T00:00:00.000Z',
    }

    expect(validateAgentEvent(agentEvent)).toBe(true)
    expect(
      validateAgentEvent({
        schemaVersion: 1,
        type: 'tool.attempt',
        sessionId,
        runId,
        callId,
        tool: 'read_file',
        stage: 'execution',
        outcome: 'succeeded',
        effects: ['filesystem.read'],
        durationMs: 1,
        inputBytes: 10,
        outputBytes: 20,
        truncated: false,
        seq: 2,
        ts: '2026-06-15T00:00:00.500Z',
      } satisfies AgentEvent),
    ).toBe(true)
    expect(
      validateAgentEvent({
        schemaVersion: 1,
        type: 'tool.completed',
        sessionId,
        runId,
        callId,
        result: { status: 'ok', content: { text: 'done' } },
        approval: {
          approver: 'model',
          decision: 'safe',
          reason: 'Read-only bounded action',
          valid: true,
        },
        seq: 3,
        ts: '2026-06-15T00:00:01.000Z',
      } satisfies AgentEvent),
    ).toBe(true)
    expect(validateTerminalEvent(terminalEvent)).toBe(true)
    expect(validateAgentEvent({ ...agentEvent, reason: undefined })).toBe(false)
  })

  it('keeps type-level IPC payloads aligned with runtime schemas', () => {
    const channel: IpcChannel = 'run:start'
    const payload: IpcPayload<typeof channel> = {
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'Summarize the repository',
      clientRequestId: 'request-1',
    }
    const validate = compileSchema(IPC_CONTRACTS[channel].payload)

    expect(validate(payload)).toBe(true)
    expect(validate({ ...payload, message: '' })).toBe(false)
  })

  it('validates the run:interject payload contract', () => {
    const channel: IpcChannel = 'run:interject'
    const payload: IpcPayload<typeof channel> = {
      version: 1,
      sessionId,
      runId,
      message: 'Supplementary detail',
      clientRequestId: 'request-interject',
    }
    const validate = compileSchema(IPC_CONTRACTS[channel].payload)

    expect(validate(payload)).toBe(true)
    expect(validate({ ...payload, message: '' })).toBe(false)
    expect(validate({ version: 1, sessionId, runId, message: 'x' })).toBe(false)
  })

  it('validates representative interjection.updated events', () => {
    const validateAgentEvent = compileSchema(AgentEventSchema)
    const base = {
      schemaVersion: 1 as const,
      sessionId,
      runId,
      interjectionId: 'interjection-1',
      content: 'queued message',
      createdAt: '2026-06-26T00:00:00.000Z',
      seq: 1,
      ts: '2026-06-26T00:00:00.000Z',
    }
    const queued: AgentEvent = {
      ...base,
      type: 'interjection.updated',
      status: 'queued',
    }
    const injected: AgentEvent = {
      ...base,
      type: 'interjection.updated',
      status: 'injected',
      injectedAfterToolBatchId: 'tool-batch-1',
    }
    const carryover: AgentEvent = {
      ...base,
      type: 'interjection.carryover',
    }

    expect(validateAgentEvent(queued)).toBe(true)
    expect(validateAgentEvent(injected)).toBe(true)
    expect(validateAgentEvent(carryover)).toBe(true)
    expect(validateAgentEvent({ ...queued, status: 'unknown' })).toBe(false)
  })

  it('requires workspace writer events to identify their event Session', () => {
    const validateAgentEvent = compileSchema(AgentEventSchema)
    const writer: AgentEvent = {
      schemaVersion: 1,
      type: 'workspace.writer.changed',
      sessionId,
      workspace: 'F:/workspace/project',
      status: 'acquired',
      writerSessionId: sessionId,
      writerRunId: runId,
      seq: 2,
      ts: '2026-06-26T00:00:00.000Z',
    }

    expect(validateAgentEvent(writer)).toBe(true)
    const missingSession = { ...writer } as Record<string, unknown>
    delete missingSession.sessionId
    expect(validateAgentEvent(missingSession)).toBe(false)
  })

  it('validates bounded trace capture status events', () => {
    const validateAgentEvent = compileSchema(AgentEventSchema)
    const capture: AgentEvent = {
      schemaVersion: 1,
      type: 'trace.capture.changed',
      sessionId,
      capture: {
        configuredEnabled: true,
        state: 'degraded',
        warning: 'trace directory unavailable',
      },
      seq: 3,
      ts: '2026-06-26T00:00:00.000Z',
    }

    expect(validateAgentEvent(capture)).toBe(true)
    expect(
      validateAgentEvent({
        ...capture,
        capture: {
          ...capture.capture,
          warning: 'x'.repeat(1_025),
        },
      }),
    ).toBe(false)
  })
})
