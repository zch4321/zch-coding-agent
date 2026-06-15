import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventId, SessionId } from '../../shared/ids'
import {
  createTraceEvent,
  type TraceEvent,
  type TraceEventInput,
} from './events'

export interface TraceLogger {
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

export class JsonlTraceLogger implements TraceLogger {
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

  private constructor(filePath: string, options: JsonlTraceLoggerOptions = {}) {
    this.#maxQueueSize = options.maxQueueSize ?? 256

    if (!Number.isInteger(this.#maxQueueSize) || this.#maxQueueSize < 1) {
      throw new RangeError('maxQueueSize must be a positive integer')
    }

    this.#stream = createWriteStream(filePath, {
      flags: 'a',
      encoding: 'utf8',
      highWaterMark: options.highWaterMark ?? 64 * 1024,
    })
    this.#stream.on('error', (error) => {
      this.#failure = error
      this.#rejectQueued(error)
    })
  }

  static async create(
    directory: string,
    sessionId: SessionId,
    options: JsonlTraceLoggerOptions = {},
  ): Promise<JsonlTraceLogger> {
    await mkdir(directory, { recursive: true })
    return new JsonlTraceLogger(
      path.join(directory, `${sessionId}.jsonl`),
      options,
    )
  }

  get queuePeak(): number {
    return this.#queuePeak
  }

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

export class NullTraceLogger implements TraceLogger {
  #nextSeq = 1

  get queuePeak(): number {
    return 0
  }

  async write(input: TraceEventInput): Promise<TraceEvent> {
    return createTraceEvent(input, this.#nextSeq++, randomUUID() as EventId)
  }

  async dispose(): Promise<void> {}
}
