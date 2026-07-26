import {
  AgentEventSchema,
  TerminalEventSchema,
  type AgentEvent,
  type TerminalEvent,
} from '../../shared/agent-events'
import type { RunId, SessionId } from '../../shared/ids'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  RunCompletion,
  RuntimeEventListener,
  RuntimeEventSink,
  RuntimeEventUnsubscribe,
} from './runtime-events'

const MAX_COMPLETIONS = 10_000
const validateAgentEvent = compileSchema(AgentEventSchema)
const validateTerminalEvent = compileSchema(TerminalEventSchema)

interface CompletionWaiter {
  resolve: (completion: RunCompletion) => void
  reject: (error: unknown) => void
  disposeAbort: () => void
}

function runKey(sessionId: SessionId, runId: RunId): string {
  return `${sessionId}\u0000${runId}`
}

function completionFrom(event: AgentEvent): RunCompletion | undefined {
  if (
    event.type !== 'run.status' ||
    (event.status !== 'completed' &&
      event.status !== 'cancelled' &&
      event.status !== 'failed')
  ) {
    return undefined
  }

  return {
    sessionId: event.sessionId,
    runId: event.runId,
    status: event.status,
    completedAt: event.ts,
    ...(event.error ? { error: { ...event.error } } : {}),
  }
}

/** Encapsulates runtime event bus behavior. */
export class RuntimeEventBus implements RuntimeEventSink {
  readonly #listeners = new Set<RuntimeEventListener>()
  readonly #completions = new Map<string, RunCompletion>()
  readonly #waiters = new Map<string, Set<CompletionWaiter>>()
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  #disposed = false

  constructor(
    options: {
      onDiagnostic?: (message: string, error?: unknown) => void
    } = {},
  ) {
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Returns or updates publish agent state. */
  publishAgent(event: AgentEvent): void {
    if (this.#disposed) return
    if (!validateAgentEvent(event)) {
      throw new Error(formatSchemaErrors(validateAgentEvent.errors))
    }

    const completion = completionFrom(event)
    if (completion) {
      this.#recordCompletion(completion)
    }
    this.#notify('onAgentEvent', event)
  }

  /** Returns or updates publish terminal state. */
  publishTerminal(event: TerminalEvent): void {
    if (this.#disposed) return
    if (!validateTerminalEvent(event)) {
      throw new Error(formatSchemaErrors(validateTerminalEvent.errors))
    }
    this.#notify('onTerminalEvent', event)
  }

  /** Returns or updates subscribe state. */
  subscribe(listener: RuntimeEventListener): RuntimeEventUnsubscribe {
    if (this.#disposed) {
      throw new Error('Runtime event bus is disposed')
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Waits for for run. */
  waitForRun(
    sessionId: SessionId,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<RunCompletion> {
    if (this.#disposed) {
      return Promise.reject(new Error('Runtime event bus is disposed'))
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    const key = runKey(sessionId, runId)
    const recorded = this.#completions.get(key)
    if (recorded) {
      return Promise.resolve(structuredClone(recorded))
    }

    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(key) ?? new Set<CompletionWaiter>()
      const abort = () => {
        waiters.delete(waiter)
        if (waiters.size === 0) this.#waiters.delete(key)
        reject(signal?.reason ?? new Error('Run wait aborted'))
      }
      const waiter: CompletionWaiter = {
        resolve,
        reject,
        disposeAbort: () => signal?.removeEventListener('abort', abort),
      }
      waiters.add(waiter)
      this.#waiters.set(key, waiters)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /** Releases all owned resources. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = new Error('Runtime event bus is disposed')
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.disposeAbort()
        waiter.reject(error)
      }
    }
    this.#waiters.clear()
    this.#completions.clear()
    this.#listeners.clear()
  }

  #recordCompletion(completion: RunCompletion): void {
    const key = runKey(completion.sessionId, completion.runId)
    this.#completions.delete(key)
    this.#completions.set(key, structuredClone(completion))
    while (this.#completions.size > MAX_COMPLETIONS) {
      const oldest = this.#completions.keys().next().value
      if (oldest === undefined) break
      this.#completions.delete(oldest)
    }

    const waiters = this.#waiters.get(key)
    if (!waiters) return
    this.#waiters.delete(key)
    for (const waiter of waiters) {
      waiter.disposeAbort()
      waiter.resolve(structuredClone(completion))
    }
  }

  #notify<Method extends keyof RuntimeEventListener>(
    method: Method,
    event: Parameters<NonNullable<RuntimeEventListener[Method]>>[0],
  ): void {
    for (const listener of this.#listeners) {
      const callback = listener[method] as
        | ((value: typeof event) => void)
        | undefined
      if (!callback) continue
      try {
        callback(structuredClone(event))
      } catch (error) {
        try {
          this.#onDiagnostic(`Runtime event listener ${method} failed`, error)
        } catch {
          // Diagnostics must not turn an isolated host-listener failure into a
          // second failure in the agent loop.
        }
      }
    }
  }
}
