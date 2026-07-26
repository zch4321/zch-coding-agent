import type { AgentEvent } from '../../shared/agent-events'
import type { LlmUsageRecord } from '../../shared/usage'
import type { TraceEvent } from '../../electron/logging/events'
import { sha256Bytes } from '../cases/hash'
import type {
  BenchmarkCostMetrics,
  BenchmarkPatchMetrics,
  BenchmarkPriceSnapshot,
  BenchmarkToolBucket,
  BenchmarkToolMetrics,
  BenchmarkTrajectoryMetrics,
  BenchmarkTrialMetrics,
  BenchmarkUsageMetrics,
  BenchmarkUsageScope,
} from './contracts'

const USAGE_SCOPES: BenchmarkUsageScope[] = [
  'main',
  'approval',
  'title',
  'compression',
]
const TOKEN_FIELDS = [
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
  'cacheHitTokens',
  'cacheMissTokens',
] as const
const PRICED_FIELDS = [
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'cacheHitTokens',
  'cacheMissTokens',
] as const

type ToolAttempt = Extract<TraceEvent, { type: 'tool.attempt' }>
type ToolCall = Extract<TraceEvent, { type: 'tool.call' }>

interface UsageObservation {
  scope: BenchmarkUsageScope
  usage?: LlmUsageRecord
}

/** Aggregates benchmark metrics. */
export function aggregateBenchmarkMetrics(input: {
  trace: readonly TraceEvent[]
  agentEvents?: readonly AgentEvent[]
  patch: string
  durationMs: number
  priceSnapshot?: BenchmarkPriceSnapshot
}): BenchmarkTrialMetrics {
  const usageObservations = collectUsage(input.trace)
  const usageByScope = Object.fromEntries(
    USAGE_SCOPES.map((scope) => [
      scope,
      summarizeUsage(
        usageObservations.filter((record) => record.scope === scope),
      ),
    ]),
  ) as Record<BenchmarkUsageScope, BenchmarkUsageMetrics>
  const usage = {
    byScope: usageByScope,
    total: summarizeUsage(usageObservations),
  }
  const tools = summarizeTools(
    input.trace,
    input.agentEvents ?? [],
    input.durationMs,
  )

  return {
    schemaVersion: 1,
    usage,
    tools,
    patch: summarizePatch(input.patch, input.trace),
    trajectory: summarizeTrajectory(input.trace, input.agentEvents ?? []),
    cost: summarizeCost(usageByScope, input.priceSnapshot),
    durationMs: Math.max(0, input.durationMs),
  }
}

function collectUsage(trace: readonly TraceEvent[]): UsageObservation[] {
  const observations = new Map<string, UsageObservation>()
  for (const event of trace) {
    if (event.type === 'llm.request') {
      const scope = event.scope ?? 'main'
      observations.set(`${scope}:${event.callId}`, { scope })
    } else if (event.type === 'approval' && event.approver === 'model') {
      const key = `approval:${event.callId}`
      if (!observations.has(key)) observations.set(key, { scope: 'approval' })
    } else if (event.type === 'llm.usage') {
      const scope = event.usage.scope
      observations.set(`${scope}:${event.callId}`, {
        scope,
        usage: event.usage,
      })
    }
  }
  return [...observations.values()]
}

function summarizeUsage(
  observations: readonly UsageObservation[],
): BenchmarkUsageMetrics {
  const result = {
    records: observations.length,
    missingRecords: observations.filter(
      ({ usage }) =>
        !usage || TOKEN_FIELDS.some((field) => usage[field] === undefined),
    ).length,
  } as BenchmarkUsageMetrics

  for (const field of TOKEN_FIELDS) {
    result[field] =
      observations.length === 0 ||
      observations.some(({ usage }) => usage?.[field] === undefined)
        ? null
        : observations.reduce(
            (total, { usage }) => total + (usage?.[field] ?? 0),
            0,
          )
  }
  return result
}

function emptyToolBucket(): BenchmarkToolBucket {
  return {
    attempted: 0,
    proposed: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    cancelled: 0,
    timedOut: 0,
    durationMs: 0,
    inputBytes: 0,
    outputBytes: 0,
    truncated: 0,
  }
}

function addAttempt(bucket: BenchmarkToolBucket, attempt: ToolAttempt): void {
  bucket.attempted += 1
  bucket.executed += attempt.stage === 'execution' ? 1 : 0
  bucket.succeeded += attempt.outcome === 'succeeded' ? 1 : 0
  bucket.denied += attempt.outcome === 'denied' ? 1 : 0
  bucket.cancelled += attempt.outcome === 'cancelled' ? 1 : 0
  bucket.timedOut += attempt.outcome === 'timeout' ? 1 : 0
  bucket.failed += ['rejected', 'failed', 'cancelled', 'timeout'].includes(
    attempt.outcome,
  )
    ? 1
    : 0
  bucket.durationMs += attempt.durationMs
  bucket.inputBytes += attempt.inputBytes
  bucket.outputBytes += attempt.outputBytes
  bucket.truncated += attempt.truncated ? 1 : 0
}

function summarizeTools(
  trace: readonly TraceEvent[],
  agentEvents: readonly AgentEvent[],
  durationMs: number,
): BenchmarkToolMetrics {
  const attempts = trace.filter(
    (event): event is ToolAttempt => event.type === 'tool.attempt',
  )
  const calls = new Map(
    trace
      .filter((event): event is ToolCall => event.type === 'tool.call')
      .map((event) => [event.callId, event]),
  )
  const proposedIds = new Set(
    agentEvents
      .filter((event) => event.type === 'tool.proposed')
      .map((event) => event.callId),
  )
  const total = emptyToolBucket()
  const byTool: Record<string, BenchmarkToolBucket> = {}
  const byEffect: Record<string, BenchmarkToolBucket> = {}
  const signatures = new Map<string, number>()
  let firstEffectiveEditMs: number | null = null
  let firstTestMs: number | null = null
  let finalVerificationMs: number | null = null
  const traceStart = firstTimestamp(trace)

  for (const attempt of attempts) {
    addAttempt(total, attempt)
    const toolBucket = (byTool[attempt.tool] ??= emptyToolBucket())
    addAttempt(toolBucket, attempt)
    for (const effect of attempt.effects) {
      const effectBucket = (byEffect[effect] ??= emptyToolBucket())
      addAttempt(effectBucket, attempt)
    }
    const call = calls.get(attempt.callId)
    if (call) {
      const signature = sha256Bytes(
        `${attempt.tool}\0${JSON.stringify(canonicalize(call.args))}`,
      )
      signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
    }
    const offset = timestampOffset(traceStart, attempt.ts)
    if (
      attempt.outcome === 'succeeded' &&
      attempt.effects.some(isWriteEffect) &&
      firstEffectiveEditMs === null
    ) {
      firstEffectiveEditMs = offset
    }
    if (call && isTestCall(attempt.tool, call.args)) {
      if (firstTestMs === null) firstTestMs = offset
      if (attempt.outcome === 'succeeded' && attempt.tool === 'run_command') {
        finalVerificationMs = offset
      }
    }
  }

  const proposed = proposedIds.size > 0 ? proposedIds.size : attempts.length
  total.proposed = proposed
  for (const [tool, bucket] of Object.entries(byTool)) {
    bucket.proposed =
      proposedIds.size > 0
        ? agentEvents.filter(
            (event) => event.type === 'tool.proposed' && event.tool === tool,
          ).length
        : bucket.attempted
  }
  for (const bucket of Object.values(byEffect))
    bucket.proposed = bucket.attempted

  return {
    ...total,
    duplicateArgumentSignatures: [...signatures.values()].reduce(
      (duplicates, count) => duplicates + Math.max(0, count - 1),
      0,
    ),
    byTool,
    byEffect,
    firstEffectiveEditMs,
    firstTestMs,
    idleAfterFinalVerificationMs:
      finalVerificationMs === null
        ? null
        : Math.max(0, durationMs - finalVerificationMs),
  }
}

function summarizePatch(
  patch: string,
  trace: readonly TraceEvent[],
): BenchmarkPatchMetrics {
  const files = new Set<string>()
  const testFiles = new Set<string>()
  const binaryFiles = new Set<string>()
  let currentFile = ''
  let addedLines = 0
  let deletedLines = 0
  for (const line of patch.split(/\r?\n/u)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
    if (match) {
      currentFile = match[2]!
      files.add(currentFile)
      if (isTestPath(currentFile)) testFiles.add(currentFile)
    } else if (/^(Binary files .* differ|GIT binary patch)$/u.test(line)) {
      if (currentFile) binaryFiles.add(currentFile)
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletedLines += 1
    }
  }
  const outsideAttempts = trace.filter(
    (event) =>
      event.type === 'tool.attempt' &&
      event.errorCode === 'PATH_OUTSIDE_WORKSPACE' &&
      event.effects.some(isWriteEffect),
  ).length
  return {
    changedFiles: files.size,
    addedLines,
    deletedLines,
    testFilesChanged: testFiles.size,
    binaryFilesChanged: binaryFiles.size,
    workspaceOutsideWriteAttempts: outsideAttempts,
  }
}

function summarizeTrajectory(
  trace: readonly TraceEvent[],
  agentEvents: readonly AgentEvent[],
): BenchmarkTrajectoryMetrics {
  const toolAttempts = trace.filter(
    (event): event is ToolAttempt => event.type === 'tool.attempt',
  )
  return {
    llmRequests: trace.filter((event) => event.type === 'llm.request').length,
    continuations: trace.filter(
      (event) =>
        event.type === 'orchestrator.message' &&
        event.kind.endsWith('-continuation'),
    ).length,
    compactions: trace.filter(
      (event) => event.type === 'llm.request' && event.scope === 'compression',
    ).length,
    planUpdates:
      agentEvents.filter((event) => event.type === 'plan.updated').length ||
      trace.filter((event) => event.type === 'plan.status').length,
    goalUpdates: agentEvents.filter((event) => event.type === 'goal.updated')
      .length,
    mcpDisclosures: toolAttempts.filter(
      (event) =>
        event.outcome === 'succeeded' &&
        ['list_mcp_servers', 'read_mcp_server'].includes(event.tool),
    ).length,
    mcpCalls: toolAttempts.filter((event) => event.tool.startsWith('mcp:'))
      .length,
    approvalRequests:
      agentEvents.filter((event) => event.type === 'approval.requested')
        .length || trace.filter((event) => event.type === 'approval').length,
    promptBuilds: trace.filter(
      (event) =>
        event.type === 'llm.request' && event.promptBuild !== undefined,
    ).length,
    terminalEvents: trace.filter((event) => event.type === 'terminal.event')
      .length,
  }
}

function summarizeCost(
  usage: Record<BenchmarkUsageScope, BenchmarkUsageMetrics>,
  snapshot?: BenchmarkPriceSnapshot,
): BenchmarkCostMetrics {
  if (!snapshot) {
    return {
      currency: 'USD',
      priceSnapshotId: null,
      totalUsd: null,
      byScope: Object.fromEntries(
        USAGE_SCOPES.map((scope) => [scope, null]),
      ) as Record<BenchmarkUsageScope, null>,
    }
  }
  validateBenchmarkPriceSnapshot(snapshot)
  const byScope = Object.fromEntries(
    USAGE_SCOPES.map((scope) => [
      scope,
      scopeCost(usage[scope], snapshot.ratesPerMillionTokens),
    ]),
  ) as Record<BenchmarkUsageScope, number | null>
  return {
    currency: 'USD',
    priceSnapshotId: snapshot.id,
    totalUsd: Object.values(byScope).some((value) => value === null)
      ? null
      : Object.values(byScope).reduce<number>(
          (total, value) => total + (value ?? 0),
          0,
        ),
    byScope,
  }
}

function scopeCost(
  usage: BenchmarkUsageMetrics,
  rates: BenchmarkPriceSnapshot['ratesPerMillionTokens'],
): number | null {
  const priced = PRICED_FIELDS.filter((field) => rates[field] !== undefined)
  if (priced.length === 0) return null
  if (usage.records === 0) return 0
  if (priced.some((field) => usage[field] === null)) return null
  return priced.reduce(
    (total, field) =>
      total + ((usage[field] ?? 0) * (rates[field] ?? 0)) / 1_000_000,
    0,
  )
}

/** Validates benchmark price snapshot. */
export function validateBenchmarkPriceSnapshot(
  snapshot: BenchmarkPriceSnapshot,
): void {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.currency !== 'USD' ||
    !snapshot.id.trim() ||
    !snapshot.source.trim() ||
    !snapshot.revision.trim() ||
    !snapshot.providerId.trim() ||
    !snapshot.model.trim() ||
    !snapshot.ratesPerMillionTokens ||
    typeof snapshot.ratesPerMillionTokens !== 'object'
  ) {
    throw new Error('Benchmark price snapshot is invalid')
  }
  for (const field of PRICED_FIELDS) {
    const value = snapshot.ratesPerMillionTokens[field]
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Benchmark price rate is invalid: ${field}`)
    }
  }
}

function firstTimestamp(trace: readonly TraceEvent[]): number {
  return trace.length > 0 ? Date.parse(trace[0]!.ts) : 0
}

function timestampOffset(start: number, timestamp: string): number {
  return Math.max(0, Date.parse(timestamp) - start)
}

function isWriteEffect(effect: string): boolean {
  return [
    'filesystem.write',
    'filesystem.delete',
    'vcs.write',
    'workspace.metadata.write',
  ].includes(effect)
}

function isTestCall(tool: string, args: unknown): boolean {
  if (!['run_command', 'terminal_open', 'terminal_send'].includes(tool)) {
    return false
  }
  const command = toolCommandText(args)
  return (
    /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|swift\s+test|mix\s+test|phpunit|ctest)\b/iu.test(
      command,
    ) ||
    /\b(?:node|bun|deno|python(?:3)?)\b[^\r\n]*(?:^|[\s\\/])(?:test|tests|__tests__|e2e)(?:[\\/]|\b)|\b(?:node|bun|deno|python(?:3)?)\b[^\r\n]*(?:\.test|\.spec)\.[A-Za-z0-9]+\b/iu.test(
      command,
    )
  )
}

function toolCommandText(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const record = args as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.data === 'string') return record.data
  if (typeof record.executable !== 'string') return ''
  const commandArgs = Array.isArray(record.args)
    ? record.args.filter((value): value is string => typeof value === 'string')
    : []
  return [record.executable, ...commandArgs].join(' ')
}

function isTestPath(file: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|(?:\.|-)(?:test|spec)\.[^/]+$/iu.test(
    file,
  )
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  )
}
