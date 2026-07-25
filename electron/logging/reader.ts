import { readFile } from 'node:fs/promises'
import type { TraceEvent } from './events'
import { TRACE_SCHEMA_VERSION, TraceEventSchema } from './events'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

const validateTraceEvent = compileSchema(TraceEventSchema)

/** Reports a complete trace record written with an unsupported schema. */
export class UnsupportedTraceSchemaError extends Error {
  constructor(
    readonly schemaVersion: unknown,
    readonly line: number,
  ) {
    super(
      `Unsupported trace schema in line ${line}; this build requires trace v${TRACE_SCHEMA_VERSION}`,
    )
    this.name = 'UnsupportedTraceSchemaError'
  }
}

/** Reports malformed data that claims the current trace schema. */
export class CorruptTraceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptTraceError'
  }
}

/** Reads and validates all complete JSONL records in one trace file. */
export async function readTraceFile(filePath: string): Promise<TraceEvent[]> {
  const content = await readFile(filePath, 'utf8')
  const hasCompleteLastLine = content.endsWith('\n')
  const lines = content.split('\n')

  if (!hasCompleteLastLine) {
    lines.pop()
  }

  const events: TraceEvent[] = []

  for (const [index, line] of lines.entries()) {
    if (!line) {
      continue
    }

    let candidate: unknown

    try {
      candidate = JSON.parse(line)
    } catch {
      throw new CorruptTraceError(`Invalid JSON in trace line ${index + 1}`)
    }

    if (!validateTraceEvent(candidate)) {
      const version =
        candidate && typeof candidate === 'object'
          ? Reflect.get(candidate, 'schemaVersion')
          : undefined
      if (version !== TRACE_SCHEMA_VERSION) {
        throw new UnsupportedTraceSchemaError(version, index + 1)
      }
      throw new CorruptTraceError(
        `Invalid trace line ${index + 1}: ${formatSchemaErrors(
          validateTraceEvent.errors,
        )}`,
      )
    }

    events.push(candidate as TraceEvent)
  }

  return events
}
