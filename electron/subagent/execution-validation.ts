import { createHash } from 'node:crypto'
import type { JsonValue } from '../../shared/json'
import { MAX_SWARM_SHARED_CONTEXT_LENGTH } from '../../shared/swarm'
import { redactTextSecrets } from '../common/redact-secrets'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  SubagentRuntimeError,
  type SubagentSpec,
  type SubagentRunResult,
  type FrozenSubagentRoutes,
} from './contracts'
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Hashes a normalized specification for durable call idempotency. */
export function specHash(spec: SubagentSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

/** Projects values into durable JSON without undefined fields. */
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Validates child names, task bounds and frozen tool access. */
export function normalizeSpec(spec: SubagentSpec): SubagentSpec {
  const name = spec.name.trim()
  const task = spec.task.trim()
  const sharedContext = spec.sharedContext?.trim()
  if (
    name.length < 1 ||
    [...name].length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    RESERVED_NAMES.has(name)
  ) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_NAME',
      'Subagent name must be a safe 1-64 character value',
    )
  }
  if (task.length < 1 || [...task].length > 32_768) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_TASK',
      'Subagent task must contain 1-32768 characters',
    )
  }
  if (spec.toolAccess !== 'readonly' && spec.toolAccess !== 'inherit') {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_TOOL_ACCESS',
      'Subagent toolAccess must be readonly or inherit',
    )
  }
  if (
    spec.sharedContext !== undefined &&
    (!sharedContext ||
      [...sharedContext].length > MAX_SWARM_SHARED_CONTEXT_LENGTH)
  ) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_SHARED_CONTEXT',
      `Subagent shared context must contain 1-${MAX_SWARM_SHARED_CONTEXT_LENGTH} characters`,
    )
  }
  return {
    name,
    task,
    toolAccess: spec.toolAccess,
    ...(sharedContext ? { sharedContext } : {}),
  }
}

/** Decodes a persisted completed child result without trusting invalid shapes. */
export function completedResult(
  record: SubagentExecutionRecord,
  expectedName: string,
): SubagentRunResult | undefined {
  const value = record.result
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const results = value.results
  const meta = value.meta
  if (
    !results ||
    typeof results !== 'object' ||
    Array.isArray(results) ||
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta)
  ) {
    return undefined
  }
  const entries = Object.entries(results)
  const usage = Reflect.get(meta, 'usage')
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== expectedName ||
    entries.some(
      ([name, result]) =>
        RESERVED_NAMES.has(name) || typeof result !== 'string',
    ) ||
    typeof Reflect.get(meta, 'durationMs') !== 'number' ||
    !Number.isFinite(Reflect.get(meta, 'durationMs')) ||
    typeof Reflect.get(meta, 'providerId') !== 'string' ||
    typeof Reflect.get(meta, 'model') !== 'string' ||
    typeof Reflect.get(meta, 'truncated') !== 'boolean' ||
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage)
  ) {
    return undefined
  }
  const usageFields = [
    'records',
    'promptTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
    'cacheHitTokens',
    'cacheMissTokens',
  ] as const
  if (
    usageFields.some((field) => {
      const count = Reflect.get(usage, field)
      return !Number.isSafeInteger(count) || Number(count) < 0
    })
  ) {
    return undefined
  }
  return {
    results: Object.fromEntries(entries) as Record<string, string>,
    meta: {
      durationMs: Reflect.get(meta, 'durationMs') as number,
      providerId: Reflect.get(meta, 'providerId') as string,
      model: Reflect.get(meta, 'model') as string,
      usage: {
        records: Reflect.get(usage, 'records') as number,
        promptTokens: Reflect.get(usage, 'promptTokens') as number,
        completionTokens: Reflect.get(usage, 'completionTokens') as number,
        reasoningTokens: Reflect.get(usage, 'reasoningTokens') as number,
        totalTokens: Reflect.get(usage, 'totalTokens') as number,
        cacheHitTokens: Reflect.get(usage, 'cacheHitTokens') as number,
        cacheMissTokens: Reflect.get(usage, 'cacheMissTokens') as number,
      },
      truncated: Reflect.get(meta, 'truncated') as boolean,
    },
  }
}

/** Normalizes execution failures to a bounded child error code. */
export function normalizedFailure(error: unknown): SubagentRuntimeError {
  if (error instanceof SubagentRuntimeError) return error
  if (error && typeof error === 'object' && 'code' in error) {
    return new SubagentRuntimeError(
      String(error.code).slice(0, 128) || 'SUBAGENT_FAILED',
      error instanceof Error ? error.message : 'Subagent execution failed',
    )
  }
  return new SubagentRuntimeError(
    'SUBAGENT_FAILED',
    error instanceof Error ? error.message : 'Subagent execution failed',
  )
}

/** Removes frozen credentials and private route data from child output. */
export function redactText(value: string, secrets: readonly string[]): string {
  return redactTextSecrets(value, secrets)
}

/** Redacts private route data and workspace identity from a final child answer. */
export function safeResultText(
  value: string,
  workspace: string,
  routes: FrozenSubagentRoutes,
): string {
  const withoutWorkspace = value.split(workspace).join('[workspace]')
  return redactText(withoutWorkspace, [
    routes.main.apiKey,
    routes.compression.apiKey,
    routes.main.snapshot.endpoint,
    routes.compression.snapshot.endpoint,
  ])
}
