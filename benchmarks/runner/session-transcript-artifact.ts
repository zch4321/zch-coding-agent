import { createHash } from 'node:crypto'
import type { TraceEvent } from '../../electron/logging/events'
import {
  normalizeSessionTranscript,
  sessionTranscriptToMarkdown,
} from '../../electron/logging/session-transcript'

export function benchmarkSessionTranscriptMarkdown(input: {
  trace: readonly TraceEvent[]
}): string {
  const session = input.trace.find(
    (event): event is Extract<TraceEvent, { type: 'session.start' }> =>
      event.type === 'session.start',
  )
  if (!session) throw new Error('Benchmark trace has no session.start event')
  const revision = createHash('sha256')
    .update(input.trace.map((event) => JSON.stringify(event)).join('\n'))
    .digest('hex')
  return sessionTranscriptToMarkdown(
    normalizeSessionTranscript(input.trace, {
      traceId: session.sessionId,
      revision,
      generatedAt: input.trace.at(-1)?.ts ?? session.ts,
      active: !input.trace.some((event) => event.type === 'session.end'),
    }),
  )
}
