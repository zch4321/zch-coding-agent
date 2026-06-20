import { createHash } from 'node:crypto'

export type OutputStream = 'stdout' | 'stderr'

export interface BoundedOutputSnapshot {
  stdout: string
  stderr: string
  truncated: boolean
  totalBytes: number
  stdoutBytes: number
  stderrBytes: number
  discardedHash?: string
}

export class BoundedProcessOutput {
  readonly #maxBytes: number
  readonly #headBytesLimit: number
  readonly #tailBytesLimit: number
  readonly #head: Array<{ stream: OutputStream; value: Buffer }> = []
  readonly #tail: Array<{ stream: OutputStream; value: Buffer }> = []
  readonly #discarded = createHash('sha256')
  #headBytes = 0
  #tailBytes = 0
  #discardedBytes = 0
  #stdoutBytes = 0
  #stderrBytes = 0

  constructor(maxBytes: number) {
    this.#maxBytes = Math.max(0, maxBytes)
    this.#headBytesLimit = Math.floor(this.#maxBytes * 0.4)
    this.#tailBytesLimit = this.#maxBytes - this.#headBytesLimit
  }

  append(stream: OutputStream, value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)

    if (stream === 'stdout') {
      this.#stdoutBytes += chunk.byteLength
    } else {
      this.#stderrBytes += chunk.byteLength
    }

    const headAvailable = Math.max(0, this.#headBytesLimit - this.#headBytes)
    const head = chunk.subarray(0, headAvailable)
    const remainder = chunk.subarray(head.byteLength)

    if (head.byteLength > 0) {
      this.#head.push({ stream, value: head })
      this.#headBytes += head.byteLength
    }

    if (remainder.byteLength > 0) {
      this.#appendTail(stream, remainder)
    }
  }

  #discard(value: Buffer): void {
    if (value.byteLength === 0) {
      return
    }

    this.#discarded.update(value)
    this.#discardedBytes += value.byteLength
  }

  #appendTail(stream: OutputStream, value: Buffer): void {
    if (this.#tailBytesLimit === 0) {
      this.#discard(value)
      return
    }

    if (value.byteLength >= this.#tailBytesLimit) {
      for (const entry of this.#tail.splice(0)) {
        this.#discard(entry.value)
      }
      this.#tailBytes = 0
      this.#discard(value.subarray(0, value.byteLength - this.#tailBytesLimit))
      const retained = value.subarray(value.byteLength - this.#tailBytesLimit)
      this.#tail.push({ stream, value: retained })
      this.#tailBytes = retained.byteLength
      return
    }

    let excess = Math.max(
      0,
      this.#tailBytes + value.byteLength - this.#tailBytesLimit,
    )

    while (excess > 0) {
      const first = this.#tail[0]

      if (!first) {
        break
      }

      const removedBytes = Math.min(excess, first.value.byteLength)
      this.#discard(first.value.subarray(0, removedBytes))
      this.#tailBytes -= removedBytes
      excess -= removedBytes

      if (removedBytes === first.value.byteLength) {
        this.#tail.shift()
      } else {
        first.value = first.value.subarray(removedBytes)
      }
    }

    this.#tail.push({ stream, value })
    this.#tailBytes += value.byteLength
  }

  #streamContent(stream: OutputStream): string {
    return Buffer.concat(
      [...this.#head, ...this.#tail]
        .filter((entry) => entry.stream === stream)
        .map((entry) => entry.value),
    ).toString('utf8')
  }

  snapshot(): BoundedOutputSnapshot {
    return {
      stdout: this.#streamContent('stdout'),
      stderr: this.#streamContent('stderr'),
      truncated: this.#discardedBytes > 0,
      totalBytes: this.#stdoutBytes + this.#stderrBytes,
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      ...(this.#discardedBytes > 0
        ? { discardedHash: this.#discarded.copy().digest('hex') }
        : {}),
    }
  }
}
