import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { EventId, RunId, SessionId } from '../../shared/ids'
import type { TraceId } from '../../shared/trace'
import {
  createTraceEvent,
  type TraceEvent,
  type TraceEventInput,
} from '../logging/events'
import type { TraceLogger } from '../logging/logger'
import { SessionTraceController } from './session-trace-controller'

const sessionId = 'session-trace-controller' as SessionId
const runId = 'run-trace-controller' as RunId

class MemoryTraceLogger implements TraceLogger {
  readonly inputs: TraceEventInput[] = []
  readonly traceId: TraceId
  readonly queuePeak = 0
  disposed = false
  #nextSeq = 1
  #failType: TraceEventInput['type'] | undefined

  constructor(traceId: TraceId, failType?: TraceEventInput['type']) {
    this.traceId = traceId
    this.#failType = failType
  }

  async write(input: TraceEventInput): Promise<TraceEvent> {
    if (this.#failType === input.type) {
      this.#failType = undefined
      throw new Error(`Injected ${input.type} failure`)
    }
    this.inputs.push(structuredClone(input))
    return createTraceEvent(input, this.#nextSeq++, randomUUID() as EventId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function createController(options: {
  enabled: boolean
  factory: (sessionId: SessionId) => TraceLogger | Promise<TraceLogger>
  onStatus?: Parameters<typeof SessionTraceController.create>[0]['onStatus']
}) {
  return SessionTraceController.create({
    sessionId,
    workspace: 'C:\\workspace',
    model: () => 'test-model',
    mode: () => 'readonly',
    configuredEnabled: options.enabled,
    factory: options.factory,
    onStatus: options.onStatus ?? (() => undefined),
  })
}

describe('SessionTraceController', () => {
  it('creates independent idle captures with explicit lifecycle events', async () => {
    const captures: MemoryTraceLogger[] = []
    const controller = await createController({
      enabled: false,
      factory: () => {
        const logger = new MemoryTraceLogger(
          `capture-${captures.length + 1}` as TraceId,
        )
        captures.push(logger)
        return logger
      },
    })

    expect(controller.status()).toEqual({
      configuredEnabled: false,
      state: 'disabled',
    })

    await controller.configure(true)
    await controller.write({ type: 'run.start', sessionId, runId })
    await controller.configure(false)
    await controller.configure(true)

    expect(captures).toHaveLength(2)
    expect(captures[0]?.traceId).not.toBe(captures[1]?.traceId)
    expect(captures[0]?.inputs.map(({ type }) => type)).toEqual([
      'session.start',
      'run.start',
      'session.end',
    ])
    expect(captures[0]?.inputs.at(-1)).toMatchObject({
      type: 'session.end',
      reason: 'logging_disabled',
    })
    expect(captures[1]?.inputs.map(({ type }) => type)).toEqual([
      'session.start',
    ])
    expect(
      captures.every((capture) => capture.inputs[0]?.type === 'session.start'),
    ).toBe(true)

    await controller.dispose()
  })

  it('applies active-run toggles only after the run boundary', async () => {
    const captures: MemoryTraceLogger[] = []
    const controller = await createController({
      enabled: false,
      factory: () => {
        const logger = new MemoryTraceLogger(
          `capture-${captures.length + 1}` as TraceId,
        )
        captures.push(logger)
        return logger
      },
    })

    await controller.beforeRun()
    await controller.configure(true)
    expect(controller.status()).toMatchObject({
      configuredEnabled: true,
      state: 'pending',
    })
    await controller.write({
      type: 'run.end',
      sessionId,
      runId,
      status: 'completed',
    })
    expect(captures).toHaveLength(0)

    await controller.afterRun()
    expect(controller.status()).toMatchObject({
      configuredEnabled: true,
      state: 'active',
      traceId: 'capture-1',
    })

    await controller.write({
      type: 'run.end',
      sessionId,
      runId,
      status: 'completed',
    })
    await controller.beforeRun()
    await controller.configure(false)
    expect(controller.status().state).toBe('pending')
    await controller.afterRun()

    expect(controller.status()).toEqual({
      configuredEnabled: false,
      state: 'disabled',
    })
    expect(captures[0]?.inputs.map(({ type }) => type)).toEqual([
      'session.start',
      'run.end',
      'session.end',
    ])
    await controller.dispose()
  })

  it('uses the last saved setting when an active run toggles repeatedly', async () => {
    const captures: MemoryTraceLogger[] = []
    const controller = await createController({
      enabled: false,
      factory: () => {
        const logger = new MemoryTraceLogger('capture-final' as TraceId)
        captures.push(logger)
        return logger
      },
    })

    await controller.beforeRun()
    await controller.configure(true)
    await controller.configure(false)
    await controller.configure(true)
    expect(controller.status()).toMatchObject({
      configuredEnabled: true,
      state: 'pending',
    })

    await controller.afterRun()
    expect(captures).toHaveLength(1)
    expect(controller.status()).toMatchObject({
      state: 'active',
      traceId: 'capture-final',
    })
    await controller.dispose()
  })

  it('degrades write failures and retries with a new capture next run', async () => {
    const captures: MemoryTraceLogger[] = []
    const statuses: string[] = []
    const controller = await createController({
      enabled: true,
      factory: () => {
        const logger = new MemoryTraceLogger(
          `capture-${captures.length + 1}` as TraceId,
          captures.length === 0 ? 'user.message' : undefined,
        )
        captures.push(logger)
        return logger
      },
      onStatus: (status) => statuses.push(status.state),
    })

    await expect(
      controller.write({
        type: 'user.message',
        sessionId,
        runId,
        text: 'continue despite trace failure',
      }),
    ).resolves.toBeDefined()
    expect(controller.status()).toMatchObject({
      configuredEnabled: true,
      state: 'degraded',
      warning: 'Injected user.message failure',
    })
    expect(captures[0]?.disposed).toBe(true)

    await controller.beforeRun()
    expect(controller.status()).toMatchObject({
      configuredEnabled: true,
      state: 'active',
      traceId: 'capture-2',
    })
    expect(statuses).toContain('degraded')
    await controller.dispose()
  })

  it('reports creation failures without throwing and retries before a run', async () => {
    let attempts = 0
    const diagnostic = vi.fn()
    const controller = await SessionTraceController.create({
      sessionId,
      workspace: 'C:\\workspace',
      model: () => 'test-model',
      mode: () => 'readonly',
      configuredEnabled: true,
      factory: () => {
        attempts += 1
        if (attempts === 1) throw new Error('capture directory unavailable')
        return new MemoryTraceLogger('capture-recovered' as TraceId)
      },
      onStatus: () => undefined,
      onDiagnostic: diagnostic,
    })

    expect(controller.status()).toMatchObject({
      state: 'degraded',
      warning: 'capture directory unavailable',
    })
    await controller.beforeRun()
    expect(controller.status()).toMatchObject({
      state: 'active',
      traceId: 'capture-recovered',
    })
    expect(diagnostic).toHaveBeenCalledOnce()
    await controller.dispose()
  })
})
