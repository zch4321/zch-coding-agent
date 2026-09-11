import { Type, type Static } from '@sinclair/typebox'
import type { LlmUsageRecord } from './usage'

export const AgentExecutionUsageSummarySchema = Type.Object(
  {
    records: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    promptTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    completionTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    reasoningTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    totalTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    cacheHitTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    cacheMissTokens: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  },
  { additionalProperties: false },
)
export type AgentExecutionUsageSummary = Static<
  typeof AgentExecutionUsageSummarySchema
>

const fields = Object.keys(
  AgentExecutionUsageSummarySchema.properties,
) as Array<keyof AgentExecutionUsageSummary>

/** Creates an independent zero-filled execution summary; Session totals keep their optional metrics. */
export function emptyExecutionUsage(): AgentExecutionUsageSummary {
  return Object.fromEntries(
    fields.map((field) => [field, 0]),
  ) as AgentExecutionUsageSummary
}

/** Projects only validated numeric summary fields and drops any private extra payload. */
export function parseExecutionUsage(
  value: unknown,
): AgentExecutionUsageSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const summary = emptyExecutionUsage()
  for (const field of fields) {
    const count: unknown = Reflect.get(value, field)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      return undefined
    summary[field] = count
  }
  return summary
}

/** Adds normalized execution totals, saturating at the public safe-integer ceiling. */
export function addExecutionUsage(
  target: AgentExecutionUsageSummary,
  source: AgentExecutionUsageSummary,
): void {
  for (const field of fields)
    target[field] = Math.min(
      Number.MAX_SAFE_INTEGER,
      target[field] + source[field],
    )
}

/** Adds one normalized call without retaining provider identity or raw response data. */
export function addExecutionUsageRecord(
  target: AgentExecutionUsageSummary,
  record: LlmUsageRecord,
): void {
  for (const field of fields) {
    const value = field === 'records' ? 1 : (record[field] ?? 0)
    target[field] = Math.min(Number.MAX_SAFE_INTEGER, target[field] + value)
  }
}

/** Aggregates normalized calls using the same arithmetic as incremental and child summaries. */
export function summarizeExecutionUsage(
  records: readonly LlmUsageRecord[],
): AgentExecutionUsageSummary {
  const total = emptyExecutionUsage()
  for (const record of records) addExecutionUsageRecord(total, record)
  return total
}
