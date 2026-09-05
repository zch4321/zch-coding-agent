import { createHash } from 'node:crypto'
import type { JsonValue } from '../../shared/json'
import { MAX_SWARM_SHARED_CONTEXT_LENGTH } from '../../shared/swarm'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  SubagentRuntimeError,
  type SubagentSpec,
  type SubagentRunResult,
  type FrozenSubagentRoutes,
} from './contracts'

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Hashes a normalized child specification for durable call idempotency. */
export function specHash(spec: SubagentSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

/** Clones a value into the persistence-safe JSON representation. */
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Validates and normalizes the child task and tool-access boundary. */
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

/** Validates and restores the persisted result for the expected child name. */
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

/** Maps worker failures to stable Subagent error codes. */
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

/** Removes runtime secrets from user-visible execution text. */
export function redactText(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (current, secret) => current.split(secret).join('[redacted]'),
      value,
    )
}

/** Redacts provider credentials, endpoints, and the workspace from child output. */
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
