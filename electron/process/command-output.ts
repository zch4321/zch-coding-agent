import { isUtf8 } from 'node:buffer'

type Stream = 'stdout' | 'stderr'

/** Decodes incremental UTF-8 output, preserving partial characters and a legacy-shell fallback. */
class StreamDecoder {
  #pending = Buffer.alloc(0)
  #fallback: TextDecoder | undefined
  constructor(readonly fallbackEncoding?: string) {}

  /** Decodes complete characters and retains an incomplete trailing UTF-8 sequence. */
  write(chunk: Buffer, final = false): string {
    if (this.#fallback) return this.#fallback.decode(chunk, { stream: !final })
    const bytes = Buffer.concat([this.#pending, chunk])
    let end = bytes.length
    if (!final && end > 0) {
      let lead = end - 1
      while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--
      const first = bytes[lead]!
      const length =
        first >= 0xf0 && first <= 0xf4
          ? 4
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xc2 && first <= 0xdf
              ? 2
              : 1
      if (end - lead < length) end = lead
    }
    const complete = bytes.subarray(0, end)
    this.#pending = Buffer.from(bytes.subarray(end))
    if (this.fallbackEncoding && !isUtf8(complete)) {
      try {
        this.#fallback = new TextDecoder(this.fallbackEncoding)
      } catch {
        /* Unsupported host encoding falls back to UTF-8. */
      }
      if (this.#fallback) {
        this.#pending = Buffer.alloc(0)
        return this.#fallback.decode(bytes, { stream: !final })
      }
    }
    return complete.toString('utf8')
  }
}

/** Keeps bounded unread stdout/stderr independently from the complete raw artifact. */
export class CommandOutput {
  readonly #decoders: Record<Stream, StreamDecoder>
  readonly #chunks: Array<{ stream: Stream; bytes: Buffer }> = []
  #bytes = 0
  #truncated = false
  #totalBytes = 0

  constructor(
    readonly maximum: number,
    fallbackEncoding?: string,
  ) {
    this.#decoders = {
      stdout: new StreamDecoder(fallbackEncoding),
      stderr: new StreamDecoder(fallbackEncoding),
    }
  }

  /** Counts raw source bytes and appends only complete decoded characters. */
  append(stream: Stream, chunk: Buffer): void {
    this.#totalBytes += chunk.length
    this.#appendText(stream, this.#decoders[stream].write(chunk))
  }

  /** Flushes incomplete final characters only after the process streams have closed. */
  finish(): void {
    for (const stream of ['stdout', 'stderr'] as const)
      this.#appendText(
        stream,
        this.#decoders[stream].write(Buffer.alloc(0), true),
      )
  }

  /** Atomically consumes unread content; concurrent readers never repeat the same output. */
  read(): {
    stdout: string
    stderr: string
    truncated: boolean
    totalBytes: number
  } {
    const result = {
      stdout: Buffer.concat(
        this.#chunks
          .filter((item) => item.stream === 'stdout')
          .map((item) => item.bytes),
      ).toString('utf8'),
      stderr: Buffer.concat(
        this.#chunks
          .filter((item) => item.stream === 'stderr')
          .map((item) => item.bytes),
      ).toString('utf8'),
      truncated: this.#truncated,
      totalBytes: this.#totalBytes,
    }
    this.#chunks.length = 0
    this.#bytes = 0
    this.#truncated = false
    return result
  }

  #appendText(stream: Stream, text: string): void {
    if (!text) return
    const bytes = Buffer.from(text)
    this.#chunks.push({ stream, bytes })
    this.#bytes += bytes.length
    while (this.#bytes > this.maximum) {
      this.#truncated = true
      const first = this.#chunks[0]!
      const remove = Math.min(first.bytes.length, this.#bytes - this.maximum)
      let end = remove
      while (end < first.bytes.length && (first.bytes[end]! & 0xc0) === 0x80)
        end++
      this.#bytes -= end
      if (end === first.bytes.length) this.#chunks.shift()
      else first.bytes = first.bytes.subarray(end)
    }
  }
}
