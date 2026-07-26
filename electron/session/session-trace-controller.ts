import type { PermissionMode } from '../../shared/config'
import type { SessionId } from '../../shared/ids'
import type { TraceCaptureStatus, TraceId } from '../../shared/trace'
import type { TraceEvent, TraceEventInput } from '../logging/events'
import { NullTraceLogger, type TraceLogger } from '../logging/logger'
import type { DiagnosticSink } from '../diagnostics'

const MAX_WARNING_LENGTH = 1_024

type TraceLoggerFactory = (
  sessionId: SessionId,
) => TraceLogger | Promise<TraceLogger>

/** Owns segmented, failure-isolated trace capture for one live Session. */
export class SessionTraceController implements TraceLogger {
  readonly #sessionId: SessionId
  readonly #workspace: string
  readonly #model: () => string
  readonly #mode: () => PermissionMode
  readonly #factory: TraceLoggerFactory
  readonly #onStatus: (status: TraceCaptureStatus) => void
  readonly #onDiagnostic: DiagnosticSink
  #logger: TraceLogger = new NullTraceLogger()
  #configuredEnabled: boolean
  #capturing = false
  #state: TraceCaptureStatus['state'] = 'disabled'
  #warning: string | undefined
  #operation: Promise<void> = Promise.resolve()
  #disposePromise: Promise<void> | undefined
  #runActive = false
  #closed = false
  #lastPublished = ''

  private constructor(options: {
    sessionId: SessionId
    workspace: string
    model: () => string
    mode: () => PermissionMode
    configuredEnabled: boolean
    factory: TraceLoggerFactory
    onStatus: (status: TraceCaptureStatus) => void
    onDiagnostic: DiagnosticSink
  }) {
    this.#sessionId = options.sessionId
    this.#workspace = options.workspace
    this.#model = options.model
    this.#mode = options.mode
    this.#configuredEnabled = options.configuredEnabled
    this.#factory = options.factory
    this.#onStatus = options.onStatus
    this.#onDiagnostic = options.onDiagnostic
  }

  /** Creates the controller and starts an initial capture when configured. */
  static async create(options: {
    sessionId: SessionId
    workspace: string
    model: () => string
    mode: () => PermissionMode
    configuredEnabled: boolean
    factory: TraceLoggerFactory
    onStatus: (status: TraceCaptureStatus) => void
    onDiagnostic?: DiagnosticSink
  }): Promise<SessionTraceController> {
    const controller = new SessionTraceController({
      ...options,
      onDiagnostic: options.onDiagnostic ?? (() => undefined),
    })
    await controller.#applyConfigured()
    return controller
  }

  /** Returns the current capture id while trace writes are active. */
  get traceId(): TraceId | undefined {
    return this.#capturing ? this.#logger.traceId : undefined
  }

  /** Returns the largest pending write count observed by the active logger. */
  get queuePeak(): number {
    return this.#logger.queuePeak
  }

  /** Returns a bounded renderer-safe view of the current capture state. */
  status(): TraceCaptureStatus {
    return {
      configuredEnabled: this.#configuredEnabled,
      state: this.#state,
      ...(this.traceId ? { traceId: this.traceId } : {}),
      ...(this.#warning ? { warning: this.#warning } : {}),
    }
  }

  /**
   * Applies a saved logging setting immediately for idle Sessions or records
   * a pending transition for the current run boundary.
   */
  async configure(enabled: boolean): Promise<TraceCaptureStatus> {
    if (this.#closed) return this.status()
    await this.#schedule(async () => {
      this.#configuredEnabled = enabled
      if (this.#runActive && enabled !== this.#capturing) {
        this.#state = 'pending'
        this.#publish()
        return
      }
      if (this.#runActive) {
        this.#warning = undefined
        this.#state = enabled ? 'active' : 'disabled'
        this.#publish()
        return
      }
      await this.#applyConfigured()
    })
    return this.status()
  }

  /** Retries degraded capture creation before the next run emits trace data. */
  async beforeRun(): Promise<void> {
    if (this.#closed) return
    await this.#schedule(async () => {
      this.#runActive = true
      await this.#applyConfigured()
    })
  }

  /** Applies the latest saved setting after the current run.end is recorded. */
  async afterRun(): Promise<void> {
    if (this.#closed) return
    await this.#schedule(async () => {
      if (this.#state === 'pending') await this.#applyConfigured()
      this.#runActive = false
    })
  }

  /** Writes without allowing trace failures to fail the Session operation. */
  async write(input: TraceEventInput): Promise<TraceEvent> {
    const logger = this.#logger
    if (!this.#capturing) return logger.write(input)
    try {
      return await logger.write(input)
    } catch (error) {
      await this.#degrade(logger, error)
      return this.#logger.write(input)
    }
  }

  /** Closes the final capture with a lifecycle reason; safe to call repeatedly. */
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#schedule(async () => {
      if (this.#closed) return
      this.#closed = true
      this.#configuredEnabled = false
      await this.#disable('session_closed')
    })
    return this.#disposePromise
  }

  async #applyConfigured(): Promise<void> {
    if (this.#closed) return
    if (this.#configuredEnabled) {
      if (!this.#capturing) await this.#enable()
      else {
        this.#warning = undefined
        this.#state = 'active'
        this.#publish()
      }
      return
    }
    await this.#disable('logging_disabled')
  }

  async #enable(): Promise<void> {
    let logger: TraceLogger | undefined
    try {
      logger = await this.#factory(this.#sessionId)
      await logger.write({
        type: 'session.start',
        sessionId: this.#sessionId,
        workspace: this.#workspace,
        model: this.#model(),
        mode: this.#mode(),
      })
      this.#logger = logger
      this.#capturing = true
      this.#warning = undefined
      this.#state = 'active'
    } catch (error) {
      await logger?.dispose().catch(() => undefined)
      this.#logger = new NullTraceLogger()
      this.#capturing = false
      this.#warning = warningFor(error)
      this.#state = 'degraded'
      this.#onDiagnostic(
        `Failed to start trace capture for ${this.#sessionId}`,
        error,
        { audience: 'internal' },
      )
    }
    this.#publish()
  }

  async #disable(reason: string): Promise<void> {
    const logger = this.#logger
    this.#logger = new NullTraceLogger()
    const wasCapturing = this.#capturing
    this.#capturing = false
    if (wasCapturing) {
      await logger
        .write({ type: 'session.end', sessionId: this.#sessionId, reason })
        .catch((error: unknown) =>
          this.#onDiagnostic(
            `Failed to close trace capture for ${this.#sessionId}`,
            error,
            { audience: 'internal' },
          ),
        )
      await logger
        .dispose()
        .catch((error: unknown) =>
          this.#onDiagnostic(
            `Failed to dispose trace capture for ${this.#sessionId}`,
            error,
            { audience: 'internal' },
          ),
        )
    }
    this.#warning = undefined
    this.#state = 'disabled'
    this.#publish()
  }

  async #degrade(logger: TraceLogger, error: unknown): Promise<void> {
    if (this.#logger !== logger || !this.#capturing) return
    this.#logger = new NullTraceLogger()
    this.#capturing = false
    this.#warning = warningFor(error)
    this.#state = this.#configuredEnabled ? 'degraded' : 'disabled'
    this.#onDiagnostic(`Trace capture failed for ${this.#sessionId}`, error, {
      audience: 'internal',
    })
    await logger.dispose().catch(() => undefined)
    this.#publish()
  }

  async #schedule(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.#operation.then(operation, operation)
    this.#operation = scheduled.catch(() => undefined)
    await scheduled
  }

  #publish(): void {
    const status = this.status()
    const serialized = JSON.stringify(status)
    if (serialized === this.#lastPublished) return
    this.#lastPublished = serialized
    this.#onStatus(status)
  }
}

function warningFor(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Trace capture failed unexpectedly'
  return message.slice(0, MAX_WARNING_LENGTH)
}
