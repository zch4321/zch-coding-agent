import { readFile } from 'node:fs/promises'
import type { TraceEvent } from './events'
import { TraceEventSchema } from './events'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

const validateTraceEvent = compileSchema(TraceEventSchema)

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
      throw new Error(`Invalid JSON in trace line ${index + 1}`)
    }

    if (!validateTraceEvent(candidate)) {
      throw new Error(
        `Invalid trace line ${index + 1}: ${formatSchemaErrors(
          validateTraceEvent.errors,
        )}`,
      )
    }

    events.push(candidate as TraceEvent)
  }

  return events
}
