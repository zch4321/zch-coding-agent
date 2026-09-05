import { createHash } from 'node:crypto'
import type { JsonValue } from '../../shared/json'
import {
  MAX_SWARM_SHARED_CONTEXT_LENGTH,
  MAX_SWARM_TASK_LENGTH,
  MAX_SWARM_TASK_NAME_LENGTH,
  SwarmRunResultSchema,
  type SwarmRunResult,
  type SwarmRunArgs,
  type SwarmTask,
  type SwarmAgentResult,
} from '../../shared/swarm'
import {
  ModelPoolAllocationError,
  type ModelPoolAssignment,
} from '../model-pool/allocator'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { SubagentSpec, SubagentUsageSummary } from '../subagent/contracts'
import { compileSchema } from '../schema-validator'
import { SwarmRuntimeError } from './contracts'

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_SWARM_RESULT_BYTES = 2_000_000
const validateSwarmResult = compileSchema(SwarmRunResultSchema)

export interface ExpandedChild {
  taskIndex: number
  agentIndex: number
  spec: SubagentSpec
}

/** Clones a Swarm value into a persistence-safe JSON representation. */
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Hashes normalized Swarm arguments for durable call idempotency. */
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function unicodeSlice(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('')
}

function displayChildName(task: SwarmTask, agentIndex: number): string {
  if (task.agentCount === 1) return task.name
  const suffix = ` · ${agentIndex}/${task.agentCount}`
  return `${unicodeSlice(
    task.name,
    MAX_SWARM_TASK_NAME_LENGTH - [...suffix].length,
  )}${suffix}`
}

/** Builds a bounded user-visible title for the Swarm assignment. */
export function displayRootName(
  goal: string | undefined,
  tasks: readonly SwarmTask[],
): string {
  const firstTask = tasks[0]?.name ?? 'Swarm'
  const label =
    goal?.trim() ||
    (tasks.length === 1 ? firstTask : `${firstTask} +${tasks.length - 1}`)
  return unicodeSlice(`Swarm · ${label}`, MAX_SWARM_TASK_NAME_LENGTH) || 'Swarm'
}

/** Validates shared context and the complete task set before reservation. */
export function normalizeArgs(
  args: SwarmRunArgs,
  maximum: number,
): SwarmRunArgs {
  const sharedContext = args.sharedContext.trim()
  if (
    [...sharedContext].length < 1 ||
    [...sharedContext].length > MAX_SWARM_SHARED_CONTEXT_LENGTH
  ) {
    throw new SwarmRuntimeError(
      'INVALID_SWARM_SHARED_CONTEXT',
      `Swarm shared context must contain 1-${MAX_SWARM_SHARED_CONTEXT_LENGTH} characters`,
    )
  }
  const names = new Set<string>()
  let total = 0
  const tasks = args.tasks.map((candidate) => {
    const name = candidate.name.trim().normalize('NFC')
    const task = candidate.task.trim()
    if (
      [...name].length < 1 ||
      [...name].length > MAX_SWARM_TASK_NAME_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(name) ||
      RESERVED_NAMES.has(name)
    ) {
      throw new SwarmRuntimeError(
        'INVALID_SWARM_TASK_NAME',
        `Swarm task names must be safe 1-${MAX_SWARM_TASK_NAME_LENGTH} character values`,
      )
    }
    if (names.has(name)) {
      throw new SwarmRuntimeError(
        'DUPLICATE_SWARM_TASK_NAME',
        `Duplicate Swarm task name: ${name}`,
      )
    }
    names.add(name)
    if ([...task].length < 1 || [...task].length > MAX_SWARM_TASK_LENGTH) {
      throw new SwarmRuntimeError(
        'INVALID_SWARM_TASK',
        `Swarm tasks must contain 1-${MAX_SWARM_TASK_LENGTH} characters`,
      )
    }
    total += candidate.agentCount
    return { ...candidate, name, task }
  })
  if (total < 1 || total > maximum) {
    throw new SwarmRuntimeError(
      'SWARM_AGENT_LIMIT_EXCEEDED',
      `A Swarm Job may create at most ${maximum} Agents`,
    )
  }
  return { sharedContext, tasks }
}

/** Expands declared task replicas in deterministic child order. */
export function expandTasks(
  sharedContext: string,
  tasks: readonly SwarmTask[],
): ExpandedChild[] {
  return tasks.flatMap((task, taskIndex) =>
    Array.from({ length: task.agentCount }, (_, index) => ({
      taskIndex,
      agentIndex: index + 1,
      spec: {
        name: displayChildName(task, index + 1),
        task: task.task,
        toolAccess: task.toolAccess,
        sharedContext,
      },
    })),
  )
}

/** Creates an empty normalized execution usage total. */
export function emptyUsage(): SubagentUsageSummary {
  return {
    records: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
}

/** Adds one child's normalized usage to the root total. */
export function addUsage(
  target: SubagentUsageSummary,
  source: SubagentUsageSummary,
): void {
  for (const field of Object.keys(target) as Array<
    keyof SubagentUsageSummary
  >) {
    target[field] += source[field]
  }
}

/** Reads bounded numeric usage from a durable child record. */
export function recordUsage(
  record: SubagentExecutionRecord,
): SubagentUsageSummary {
  const candidate = record.usage
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return emptyUsage()
  }
  const usage = emptyUsage()
  for (const field of Object.keys(usage) as Array<keyof SubagentUsageSummary>) {
    const value = candidate[field]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      return emptyUsage()
    }
    usage[field] = value
  }
  return usage
}

/** Maps a failed child record to the public Swarm result status. */
export function resultStatus(
  record: SubagentExecutionRecord | undefined,
): SwarmAgentResult['status'] {
  if (record?.status === 'cancelled') return 'cancelled'
  if (record?.status === 'timed_out') return 'timed_out'
  return 'failed'
}

/** Projects a frozen assignment without private provider credentials. */
export function assignmentResult(assignment: ModelPoolAssignment) {
  return {
    providerId: assignment.providerId,
    model: assignment.model,
    reasoning: assignment.reasoning,
    capability: assignment.capability,
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return new TextDecoder().decode(bytes.subarray(0, maximumBytes))
}

/** Bounds aggregate result text while preserving every child's result metadata. */
export function boundResult(result: SwarmRunResult): SwarmRunResult {
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_SWARM_RESULT_BYTES
  ) {
    return result
  }
  const originals = result.results.map(
    (entry) => entry.response ?? entry.error?.message ?? '',
  )
  let lower = 0
  let upper = Math.max(
    0,
    ...originals.map((value) => Buffer.byteLength(value, 'utf8')),
  )
  const emptyText = structuredClone(result)
  for (const entry of emptyText.results) {
    if (entry.response !== undefined) entry.response = ''
    else if (entry.error) entry.error.message = ''
    entry.truncated = true
  }
  let bounded = emptyText
  while (lower <= upper) {
    const perResponse = Math.floor((lower + upper) / 2)
    const candidate = structuredClone(result)
    for (const [index, entry] of candidate.results.entries()) {
      const text = truncateUtf8(originals[index]!, perResponse)
      if (entry.response !== undefined) entry.response = text
      else if (entry.error) entry.error.message = text
      entry.truncated = entry.truncated || text !== originals[index]
    }
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
      MAX_SWARM_RESULT_BYTES
    ) {
      bounded = candidate
      lower = perResponse + 1
    } else {
      upper = perResponse - 1
    }
  }
  return bounded
}

/** Validates a previously stored Swarm result before idempotent reuse. */
export function persistedResult(
  record: SubagentExecutionRecord,
): SwarmRunResult | undefined {
  if (!record.result || !validateSwarmResult(record.result)) return undefined
  return structuredClone(record.result) as SwarmRunResult
}

/** Normalizes preparation and worker errors to stable Swarm errors. */
export function normalizedError(error: unknown): SwarmRuntimeError {
  if (error instanceof SwarmRuntimeError) return error
  if (error instanceof ModelPoolAllocationError) {
    return new SwarmRuntimeError(
      'SWARM_MODEL_POOL_UNSATISFIED',
      `The model pool cannot satisfy ${error.capability} capability`,
    )
  }
  return new SwarmRuntimeError(
    error && typeof error === 'object' && 'code' in error
      ? String(error.code).slice(0, 128) || 'SWARM_FAILED'
      : 'SWARM_FAILED',
    error instanceof Error ? error.message : 'Swarm execution failed',
  )
}
