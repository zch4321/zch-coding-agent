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

export class HeadlessEventWriter {
  readonly #stream: Writable
  #sequence = 0

  constructor(stream: Writable) {
    this.#stream = stream
  }

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

export interface HeadlessUsageTotals {
  records: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export class HeadlessRunMetrics implements RuntimeEventListener {
  readonly usage: HeadlessUsageTotals = {
    records: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
  readonly tools = { proposed: 0, completed: 0, failed: 0 }
  finalResponse: string | undefined
  goal: GoalState | undefined
  plan: PlanState | undefined

  constructor(private readonly writer: HeadlessEventWriter) {}

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
      const usage = event.usage
      this.usage.records += 1
      this.usage.promptTokens += usage.promptTokens ?? 0
      this.usage.completionTokens += usage.completionTokens ?? 0
      this.usage.reasoningTokens += usage.reasoningTokens ?? 0
      this.usage.totalTokens += usage.totalTokens ?? 0
      this.usage.cacheHitTokens += usage.cacheHitTokens ?? 0
      this.usage.cacheMissTokens += usage.cacheMissTokens ?? 0
    }
  }

  onTerminalEvent = (event: TerminalEvent): void => {
    this.writer.write({ type: 'terminal.event', event })
  }
}
