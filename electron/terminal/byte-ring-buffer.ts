export interface ByteRingSnapshot {
  data: string
  startCursor: number
  cursor: number
  totalBytes: number
  retainedBytes: number
  truncated: boolean
}

export class ByteRingBuffer {
  readonly #capacity: number
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #totalBytes = 0

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity)
  }

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

  clear(): void {
    this.#buffer = Buffer.alloc(0)
    this.#totalBytes = 0
  }
}
