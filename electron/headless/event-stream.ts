import {
  emptyExecutionUsage,
  addExecutionUsageRecord,
  type AgentExecutionUsageSummary,
} from '../../shared/execution-usage'
import type { Writable } from 'node:stream'
import type { AgentEvent, TerminalEvent } from '../../shared/agent-events'
import type { GoalState, PlanState } from '../../shared/orchestration'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type { RuntimeEventListener } from '../runtime/runtime-events'
import {
  HeadlessStreamEventSchema,
  type HeadlessStreamEvent,
  type HeadlessStreamEventDraft,
} from './contracts'

const validateStreamEvent = compileSchema(HeadlessStreamEventSchema)

/** Writes sequenced headless events to a writable output stream. */
export class HeadlessEventWriter {
  readonly #stream: Writable
  #sequence = 0

  constructor(stream: Writable) {
    this.#stream = stream
  }

  /** Assigns schema version, sequence, and timestamp before writing one event. */
  write(draft: HeadlessStreamEventDraft): HeadlessStreamEvent {
    const event = {
      schemaVersion: 1,
      seq: ++this.#sequence,
      ts: new Date().toISOString(),
      ...draft,
    } as HeadlessStreamEvent
    if (!validateStreamEvent(event)) {
      throw new Error(formatSchemaErrors(validateStreamEvent.errors))
    }
    this.#stream.write(`${JSON.stringify(event)}\n`)
    return event
  }
}

export type HeadlessUsageTotals = AgentExecutionUsageSummary

/** Accumulates usage, response, goal, and terminal metrics from runtime events. */
export class HeadlessRunMetrics implements RuntimeEventListener {
  readonly usage: HeadlessUsageTotals = emptyExecutionUsage()
  readonly tools = { proposed: 0, completed: 0, failed: 0 }
  finalResponse: string | undefined
  goal: GoalState | undefined
  plan: PlanState | undefined

  constructor(private readonly writer: HeadlessEventWriter) {}

  /** Writes an agent event and updates final response, goal, and usage metrics. */
  onAgentEvent = (event: AgentEvent): void => {
    this.writer.write({ type: 'agent.event', event })
    if (event.type === 'assistant.message.completed') {
      this.finalResponse = event.text
    } else if (event.type === 'goal.updated') {
      this.goal = event.goal ? structuredClone(event.goal) : undefined
    } else if (event.type === 'plan.updated') {
      this.plan = event.plan ? structuredClone(event.plan) : undefined
    } else if (event.type === 'tool.proposed') {
      this.tools.proposed += 1
    } else if (event.type === 'tool.completed') {
      this.tools.completed += 1
      if (event.result.status !== 'ok') this.tools.failed += 1
    } else if (event.type === 'llm.usage') {
      addExecutionUsageRecord(this.usage, event.usage)
    }
  }

  /** Writes a terminal event to the headless event stream. */
  onTerminalEvent = (event: TerminalEvent): void => {
    this.writer.write({ type: 'terminal.event', event })
  }
}
