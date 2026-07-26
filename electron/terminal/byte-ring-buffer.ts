export interface ByteRingSnapshot {
  data: string
  startCursor: number
  cursor: number
  totalBytes: number
  retainedBytes: number
  truncated: boolean
}

/** Stores recent bytes in a fixed-capacity ring while tracking the absolute cursor. */
export class ByteRingBuffer {
  readonly #capacity: number
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #totalBytes = 0

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity)
  }

  /** Appends bytes and discards the oldest data when capacity is exceeded. */
  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.#totalBytes += chunk.byteLength

    if (chunk.byteLength >= this.#capacity) {
      this.#buffer = chunk.subarray(chunk.byteLength - this.#capacity)
      return
    }

    const combined = Buffer.concat([this.#buffer, chunk])
    this.#buffer =
      combined.byteLength > this.#capacity
        ? combined.subarray(combined.byteLength - this.#capacity)
        : combined
  }

  /** Returns bounded bytes from a cursor together with the current cursor range. */
  snapshot(cursor?: number): ByteRingSnapshot {
    const startCursor = this.#totalBytes - this.#buffer.byteLength
    const requestedCursor = Math.max(0, cursor ?? startCursor)
    const effectiveCursor = Math.max(startCursor, requestedCursor)
    const offset = Math.min(
      this.#buffer.byteLength,
      Math.max(0, effectiveCursor - startCursor),
    )

    return {
      data: this.#buffer.subarray(offset).toString('utf8'),
      startCursor,
      cursor: this.#totalBytes,
      totalBytes: this.#totalBytes,
      retainedBytes: this.#buffer.byteLength,
      truncated: requestedCursor < startCursor,
    }
  }

  /** Clears buffered bytes and resets the absolute cursor. */
  clear(): void {
    this.#buffer = Buffer.alloc(0)
    this.#totalBytes = 0
  }
}
