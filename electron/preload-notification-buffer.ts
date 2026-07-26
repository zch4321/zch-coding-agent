import { IPC_VERSION } from '../shared/channels'
import type { BackendNotificationEnvelope } from '../shared/notifications'

type NotificationListener = (event: BackendNotificationEnvelope) => void

/** Buffers bounded backend notifications until the renderer subscribes. */
export class BackendNotificationBuffer {
  readonly #capacity: number
  readonly #now: () => string
  readonly #listeners = new Set<NotificationListener>()
  readonly #buffer: BackendNotificationEnvelope[] = []
  #overflowed = false

  constructor(options: { capacity: number; now?: () => string }) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new TypeError('Notification buffer capacity must be positive')
    }
    this.#capacity = options.capacity
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** Publishes an event immediately or retains it until the first listener. */
  push(event: BackendNotificationEnvelope): void {
    if (this.#listeners.size > 0) {
      this.#deliver(event)
      return
    }
    if (this.#buffer.length >= this.#capacity) {
      this.#buffer.shift()
      this.#overflowed = true
    }
    this.#buffer.push(event)
  }

  /** Subscribes a listener and replays the bounded pre-mount buffer once. */
  subscribe(listener: NotificationListener): () => void {
    this.#listeners.add(listener)
    if (this.#listeners.size === 1) {
      const buffered = this.#buffer.splice(0)
      if (this.#overflowed) {
        this.#overflowed = false
        this.#invoke(listener, {
          version: IPC_VERSION,
          id: 'notification:preload-buffer-overflow',
          severity: 'warning',
          code: 'NOTIFICATION_BUFFER_OVERFLOW',
          message:
            'Some backend notifications were omitted before the interface was ready.',
          occurredAt: this.#now(),
        })
      }
      for (const event of buffered) this.#invoke(listener, event)
    }
    return () => this.#listeners.delete(listener)
  }

  #deliver(event: BackendNotificationEnvelope): void {
    for (const listener of this.#listeners) this.#invoke(listener, event)
  }

  #invoke(
    listener: NotificationListener,
    event: BackendNotificationEnvelope,
  ): void {
    try {
      listener(event)
    } catch {
      // One renderer listener must not block other notification consumers.
    }
  }
}
