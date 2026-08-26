import type {
  AgentExecutionActivity,
  AgentExecutionLiveOverlay,
  AgentExecutionSummary,
  AgentExecutionUsageSummary,
} from '../../shared/agent-execution'
import type { JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import { unwrapSwarmTaskContent } from './assignment-prompt'

const USAGE_FIELDS = [
  'records',
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
  'cacheHitTokens',
  'cacheMissTokens',
] as const

function objectValue(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function routeIdentity(record: SubagentExecutionRecord): {
  providerId?: string
  model?: string
} {
  const route = objectValue(record.route)
  const main = objectValue(route?.main)
  return {
    ...(typeof main?.providerId === 'string'
      ? { providerId: main.providerId }
      : {}),
    ...(typeof main?.model === 'string' ? { model: main.model } : {}),
  }
}

function usageSummary(
  value: JsonValue | undefined,
): AgentExecutionUsageSummary | undefined {
  const candidate = objectValue(value)
  if (
    !candidate ||
    USAGE_FIELDS.some(
      (field) =>
        !Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0,
    )
  ) {
    return undefined
  }
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, Number(candidate[field])]),
  ) as unknown as AgentExecutionUsageSummary
}

function completedResultName(
  record: SubagentExecutionRecord,
): string | undefined {
  const result = objectValue(record.result)
  const results = objectValue(result?.results)
  const names = results ? Object.keys(results) : []
  return names.length === 1 ? names[0] : undefined
}

function childTitleName(child?: SessionRecord): string | undefined {
  if (!child) return undefined
  const prefix = 'Subagent: '
  return child.title.startsWith(prefix)
    ? child.title.slice(prefix.length).trim()
    : child.title.trim()
}

/** Produces the bounded, renderer-safe summary for one hidden execution. */
export function projectAgentExecutionSummary(
  record: SubagentExecutionRecord,
  input: {
    name?: string
    child?: SessionRecord
    agentCounts?: AgentExecutionSummary['agentCounts']
  } = {},
): AgentExecutionSummary {
  const route = routeIdentity(record)
  const name =
    input.name?.trim() ||
    (record.name === 'Subagent' ? childTitleName(input.child) : undefined) ||
    record.name.trim() ||
    completedResultName(record) ||
    'Subagent'
  const usage = usageSummary(record.usage)
  return {
    schemaVersion: 1,
    id: record.id,
    kind: record.kind,
    parentSessionId: record.parentSessionId,
    parentRunId: record.parentRunId,
    parentCallId: record.parentCallId,
    ...(record.parentExecutionId
      ? { parentExecutionId: record.parentExecutionId }
      : {}),
    ...(record.childOrdinal === undefined
      ? {}
      : { childOrdinal: record.childOrdinal }),
    name: [...name].slice(0, 64).join('') || 'Subagent',
    status: record.status,
    ...(input.child
      ? {
          providerId: input.child.modelSelection.providerId,
          model: input.child.modelSelection.model,
        }
      : route),
    ...(usage ? { usage } : {}),
    ...(input.agentCounts
      ? { agentCounts: structuredClone(input.agentCounts) }
      : {}),
    ...(record.error ? { error: { ...record.error } } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  }
}

/** Extracts the delegated task without exposing hidden prompt layers. */
export function projectAgentExecutionTask(
  record: Extract<MessageRecord, { kind: 'user_input' }> | undefined,
): string | undefined {
  const task = record?.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
  return (task && unwrapSwarmTaskContent(task)) || task || undefined
}

/** Removes child run identity while retaining its actionable approval state. */
export function projectAgentExecutionLiveOverlay(
  snapshot: ActiveRunPublicSnapshot | undefined,
): AgentExecutionLiveOverlay | undefined {
  if (!snapshot) return undefined
  return {
    schemaVersion: 1,
    status: snapshot.status,
    text: snapshot.text,
    reasoning: snapshot.reasoning,
    ...(snapshot.providerRetry
      ? { providerRetry: structuredClone(snapshot.providerRetry) }
      : {}),
    ...(snapshot.approval
      ? { approval: structuredClone(snapshot.approval) }
      : {}),
    tools: snapshot.tools.map((tool) => ({
      callId: tool.callId,
      tool: tool.tool,
      args: structuredClone(tool.arguments ?? {}),
      reason: '',
      status: tool.status === 'completed' ? 'completed' : 'proposed',
      ...(tool.result ? { result: structuredClone(tool.result) } : {}),
    })),
  }
}

/** Projects visible canonical records into a chronological execution activity list. */
export function projectAgentExecutionActivities(
  records: readonly MessageRecord[],
): AgentExecutionActivity[] {
  const activities: AgentExecutionActivity[] = []
  const tools = new Map<
    string,
    Extract<AgentExecutionActivity, { type: 'tool' }>
  >()

  for (const record of [...records].sort(
    (left, right) => left.seq - right.seq,
  )) {
    if (record.visibility !== 'visible') continue
    if (record.kind === 'assistant_turn') {
      if (record.normalizedReasoningText?.trim()) {
        activities.push({
          type: 'reasoning',
          id: `${record.id}:reasoning`,
          seq: record.seq,
          ordinal: 0,
          text: record.normalizedReasoningText,
        })
      }
      for (const [index, part] of record.parts.entries()) {
        if (part.type === 'text' && part.text.trim()) {
          activities.push({
            type: 'message',
            id: `${record.id}:text:${index}`,
            seq: record.seq,
            ordinal: index + 1,
            text: part.text,
          })
        } else if (part.type === 'tool_call') {
          const activity: Extract<AgentExecutionActivity, { type: 'tool' }> = {
            type: 'tool',
            id: part.callId,
            seq: record.seq,
            ordinal: index + 1,
            callId: part.callId,
            tool: part.name,
            args: structuredClone(part.arguments),
            reason: '',
            status: 'proposed',
          }
          activities.push(activity)
          tools.set(part.callId, activity)
        }
      }
      continue
    }
    if (record.kind !== 'tool_result') continue
    const part = record.parts[0]
    const existing = tools.get(part.callId)
    if (existing) {
      existing.status = 'completed'
      existing.result = structuredClone(part)
      existing.reason = record.metadata?.tool.reason ?? existing.reason
      continue
    }
    const activity: Extract<AgentExecutionActivity, { type: 'tool' }> = {
      type: 'tool',
      id: part.callId,
      seq: record.seq,
      ordinal: 0,
      callId: part.callId,
      tool: record.metadata?.tool.name ?? 'unknown',
      args: {},
      reason: record.metadata?.tool.reason ?? '',
      status: 'completed',
      result: structuredClone(part),
    }
    activities.push(activity)
    tools.set(part.callId, activity)
  }

  return activities.sort(
    (left, right) => left.seq - right.seq || left.ordinal - right.ordinal,
  )
}
