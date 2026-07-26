import type { WriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventId, SessionId } from '../../shared/ids'
import type { TraceId } from '../../shared/trace'
import {
  createTraceEvent,
  type TraceEvent,
  type TraceEventInput,
} from './events'

export interface TraceLogger {
  readonly traceId?: TraceId
  readonly queuePeak: number
  write(input: TraceEventInput): Promise<TraceEvent>
  dispose(): Promise<void>
}

interface QueueItem {
  event: TraceEvent
  resolve: (event: TraceEvent) => void
  reject: (error: unknown) => void
}

export interface JsonlTraceLoggerOptions {
  maxQueueSize?: number
  highWaterMark?: number
}

function captureIdForSession(sessionId: SessionId): TraceId {
  const readable =
    sessionId.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 80) || 'session'
  return `capture-${readable}-${randomUUID()}` as TraceId
}

/** Writes jsonl trace log records. */
export class JsonlTraceLogger implements TraceLogger {
  readonly traceId: TraceId
  readonly #stream: WriteStream
  readonly #maxQueueSize: number
  readonly #queue: QueueItem[] = []
  readonly #capacityWaiters: Array<() => void> = []
  readonly #idleWaiters: Array<() => void> = []
  #pending = 0
  #nextSeq = 1
  #pumping = false
  #closing = false
  #closed = false
  #failure: unknown
  #queuePeak = 0
  #disposePromise: Promise<void> | undefined

  private constructor(
    traceId: TraceId,
    stream: WriteStream,
    options: JsonlTraceLoggerOptions = {},
  ) {
    this.traceId = traceId
    this.#maxQueueSize = options.maxQueueSize ?? 256

    if (!Number.isInteger(this.#maxQueueSize) || this.#maxQueueSize < 1) {
      throw new RangeError('maxQueueSize must be a positive integer')
    }

    this.#stream = stream
    this.#stream.on('error', (error) => {
      this.#failure = error
      this.#rejectQueued(error)
    })
  }

  /** Creates a new instance. */
  static async create(
    directory: string,
    sessionId: SessionId,
    options: JsonlTraceLoggerOptions = {},
  ): Promise<JsonlTraceLogger> {
    const maxQueueSize = options.maxQueueSize ?? 256
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new RangeError('maxQueueSize must be a positive integer')
    }
    await mkdir(directory, { recursive: true })
    const traceId = captureIdForSession(sessionId)
    const file = await open(path.join(directory, `${traceId}.jsonl`), 'wx')
    try {
      const stream = file.createWriteStream({
        encoding: 'utf8',
        highWaterMark: options.highWaterMark ?? 64 * 1024,
      })
      return new JsonlTraceLogger(traceId, stream, options)
    } catch (error) {
      await file.close().catch(() => undefined)
      throw error
    }
  }

  /** Queues peak. */
  get queuePeak(): number {
    return this.#queuePeak
  }

  /** Writes the supplied data. */
  async write(input: TraceEventInput): Promise<TraceEvent> {
    if (this.#closing || this.#closed) {
      throw new Error('Trace logger is closing')
    }

    if (this.#failure) {
      throw this.#failure
    }

    await this.#acquireCapacity()

    if (this.#closing || this.#closed || this.#failure) {
      this.#releaseCapacity()
      if (this.#failure) {
        throw this.#failure
      }
      throw new Error('Trace logger is closing')
    }

    const event = createTraceEvent(
      input,
      this.#nextSeq++,
      randomUUID() as EventId,
    )
    this.#queuePeak = Math.max(this.#queuePeak, this.#pending)

    return new Promise<TraceEvent>((resolve, reject) => {
      this.#queue.push({ event, resolve, reject })
      void this.#pump()
    })
  }

  /** Releases all owned resources. */
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    if (this.#closed) {
      return
    }

    this.#closing = true

    if (this.#pending > 0) {
      await new Promise<void>((resolve) => {
        this.#idleWaiters.push(resolve)
      })
    }

    await new Promise<void>((resolve, reject) => {
      this.#stream.end((error?: Error | null) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
    this.#closed = true

    if (this.#failure) {
      throw this.#failure
    }
  }

  async #acquireCapacity(): Promise<void> {
    while (this.#pending >= this.#maxQueueSize) {
      await new Promise<void>((resolve) => {
        this.#capacityWaiters.push(resolve)
      })
    }

    this.#pending += 1
  }

  async #pump(): Promise<void> {
    if (this.#pumping) {
      return
    }

    this.#pumping = true

    while (this.#queue.length > 0) {
      const item = this.#queue.shift()

      if (!item) {
        break
      }

      try {
        await this.#writeLine(`${JSON.stringify(item.event)}\n`)
        item.resolve(item.event)
      } catch (error) {
        this.#failure = error
        item.reject(error)
        this.#rejectQueued(error)
      } finally {
        this.#releaseCapacity()
      }

      if (this.#failure) {
        break
      }
    }

    this.#pumping = false

    if (this.#pending === 0) {
      for (const resolve of this.#idleWaiters.splice(0)) {
        resolve()
      }
    }
  }

  async #writeLine(line: string): Promise<void> {
    let needsDrain = false
    const written = new Promise<void>((resolve, reject) => {
      needsDrain = !this.#stream.write(line, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
    const drained = needsDrain
      ? new Promise<void>((resolve) => this.#stream.once('drain', resolve))
      : Promise.resolve()

    await Promise.all([written, drained])
  }

  #rejectQueued(error: unknown): void {
    for (const item of this.#queue.splice(0)) {
      item.reject(error)
      this.#releaseCapacity()
    }

    for (const resolve of this.#capacityWaiters.splice(0)) {
      resolve()
    }

    if (this.#pending === 0) {
      for (const resolve of this.#idleWaiters.splice(0)) {
        resolve()
      }
    }
  }

  #releaseCapacity(): void {
    this.#pending -= 1
    this.#capacityWaiters.shift()?.()
  }
}

/** Provides a no-op trace logger implementation. */
export class NullTraceLogger implements TraceLogger {
  readonly traceId = undefined
  #nextSeq = 1

  /** Queues peak. */
  get queuePeak(): number {
    return 0
  }

  /** Writes the supplied data. */
  async write(input: TraceEventInput): Promise<TraceEvent> {
    return createTraceEvent(input, this.#nextSeq++, randomUUID() as EventId)
  }

  /** Releases all owned resources. */
  async dispose(): Promise<void> {}
}
