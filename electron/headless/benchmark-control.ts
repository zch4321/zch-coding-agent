import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import {
  HeadlessBenchmarkDecisionSchema,
  type HeadlessBenchmarkController,
  type HeadlessBenchmarkDecision,
} from './contracts'

const MAX_DECISION_BYTES = 32 * 1024
const validateDecision = compileSchema(HeadlessBenchmarkDecisionSchema)

export class StdinBenchmarkController implements HeadlessBenchmarkController {
  readonly protocol = 'repair-once' as const
  readonly #decision: Promise<HeadlessBenchmarkDecision>

  constructor(input: Readable) {
    this.#decision = readDecision(input)
  }

  async waitForDecision(input: {
    signal: AbortSignal
  }): Promise<HeadlessBenchmarkDecision> {
    if (input.signal.aborted) throw input.signal.reason
    return await Promise.race([
      this.#decision,
      new Promise<never>((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(input.signal.reason),
          { once: true },
        )
      }),
    ])
  }
}

async function readDecision(
  input: Readable,
): Promise<HeadlessBenchmarkDecision> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    const line = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve)
      lines.once('close', () =>
        reject(new Error('Benchmark control stdin closed')),
      )
      lines.once('error', reject)
    })
    if (Buffer.byteLength(line) > MAX_DECISION_BYTES) {
      throw new Error('Benchmark decision exceeds 32 KiB')
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('Benchmark decision is not valid JSON')
    }
    if (!validateDecision(value)) {
      throw new Error(formatSchemaErrors(validateDecision.errors))
    }
    return structuredClone(value) as HeadlessBenchmarkDecision
  } finally {
    lines.close()
  }
}
