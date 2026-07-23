import type { AgentEvent } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type { PromptBuildSummary } from '../../shared/trace'
import type { ChatCompletionsRequestDto } from '../providers/provider-protocol'
import type { ToolResult } from '../tools/types'

export interface ParityProviderRequest {
  messages: ChatCompletionsRequestDto['messages']
  tools: ChatCompletionsRequestDto['tools']
}

export interface ParityTraceRequest {
  promptResources: Array<{
    id: string
    version: string
    sha256: string
  }>
  promptBuild?: PromptBuildSummary
}

export interface RuntimeParityCapture {
  providerRequests: ParityProviderRequest[]
  traceRequests: ParityTraceRequest[]
  events: AgentEvent[]
  patch: string
}

export interface NormalizedRuntimeParityCapture {
  providerRequests: JsonValue
  traceRequests: JsonValue
  tools: JsonValue
  patch: string
}

export interface RuntimeParityDifference {
  path: string
  left: unknown
  right: unknown
}

export class RuntimeParityMismatchError extends Error {
  readonly code = 'RUNTIME_PARITY_MISMATCH'
  readonly differences: RuntimeParityDifference[]

  constructor(differences: RuntimeParityDifference[]) {
    super(
      `Runtime host parity mismatch: ${differences
        .map((difference) => difference.path)
        .join(', ')}`,
    )
    this.name = 'RuntimeParityMismatchError'
    this.differences = structuredClone(differences)
  }
}

export function normalizeRuntimeParityCapture(
  capture: RuntimeParityCapture,
  workspace: string,
): NormalizedRuntimeParityCapture {
  return {
    providerRequests: normalizeProviderRequests(
      capture.providerRequests,
      workspace,
    ),
    traceRequests: normalizeTraceRequests(capture.traceRequests, workspace),
    tools: normalizeToolEvents(capture.events, workspace),
    patch: normalizePatch(capture.patch, workspace),
  }
}

function normalizeProviderRequests(
  requests: ParityProviderRequest[],
  workspace: string,
): JsonValue {
  return requests.map((request) => {
    const normalized = {
      messages: request.messages.map((message) =>
        normalizeValue(
          message as unknown as JsonValue,
          workspace,
          '',
          message.role === 'tool',
        ),
      ),
      tools: request.tools.map((tool) => normalizeValue(tool, workspace)),
    }
    const approvalIndex = normalized.messages.findIndex(isApprovalMessage)
    let runtimeIndex = -1
    for (let index = normalized.messages.length - 1; index >= 0; index -= 1) {
      if (isRuntimeMessage(normalized.messages[index]!)) {
        runtimeIndex = index
        break
      }
    }
    if (approvalIndex === runtimeIndex + 1) {
      const [approval] = normalized.messages.splice(approvalIndex, 1)
      normalized.messages.splice(runtimeIndex, 0, approval!)
    }
    return normalized
  }) as JsonValue
}

export function assertRuntimeHostParity(
  left: NormalizedRuntimeParityCapture,
  right: NormalizedRuntimeParityCapture,
): void {
  const differences: RuntimeParityDifference[] = []
  compareValues(
    left as unknown as JsonValue,
    right as unknown as JsonValue,
    '',
    differences,
  )
  if (differences.length > 0) throw new RuntimeParityMismatchError(differences)
}

function normalizeTraceRequests(
  requests: ParityTraceRequest[],
  workspace: string,
): JsonValue {
  return requests.map((request) => ({
    promptResources: [...request.promptResources]
      .map(({ id, version, sha256 }) => ({ id, version, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ...(request.promptBuild
      ? {
          promptBuild: {
            schemaVersion: request.promptBuild.schemaVersion,
            layers: request.promptBuild.layers
              .filter((layer) => layer.kind !== 'orchestrator')
              .map((layer) => ({
                kind: layer.kind,
                source: normalizeString(layer.source, workspace),
                trusted: layer.trusted,
                editable: layer.editable,
                sha256:
                  layer.kind === 'runtime_context'
                    ? '<normalized-runtime-context>'
                    : layer.sha256,
                included: layer.included,
                truncated: layer.truncated,
              })),
            toolsHash: request.promptBuild.toolsHash,
          },
        }
      : {}),
  })) as JsonValue
}

function normalizeToolEvents(
  events: AgentEvent[],
  workspace: string,
): JsonValue {
  const proposals = new Map<
    string,
    Extract<AgentEvent, { type: 'tool.proposed' }>
  >()
  const observations: Array<{
    tool: string
    args: JsonValue
    result: ToolResult
  }> = []
  for (const event of events) {
    if (event.type === 'tool.proposed') {
      proposals.set(event.callId, event)
    } else if (event.type === 'tool.completed') {
      const proposal = proposals.get(event.callId)
      if (!proposal) continue
      observations.push({
        tool: proposal.tool,
        args: proposal.args,
        result: event.result,
      })
    }
  }
  return observations.map((observation) => ({
    tool: observation.tool,
    args: normalizeValue(observation.args, workspace),
    result: normalizeValue(
      observation.result as unknown as JsonValue,
      workspace,
      '',
      true,
    ),
  }))
}

function normalizePatch(patch: string, workspace: string): string {
  return normalizeString(
    patch
      .replace(/\r\n/gu, '\n')
      .split('\n')
      .filter((line) => !/^index [0-9a-f]+\.\.[0-9a-f]+/u.test(line))
      .join('\n')
      .trim(),
    workspace,
  )
}

function normalizeValue(
  value: JsonValue,
  workspace: string,
  key = '',
  stripExecutionMetrics = false,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeValue(item, workspace, '', stripExecutionMetrics),
    )
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([nestedKey]) =>
            !stripExecutionMetrics || !EXECUTION_METRIC_KEYS.has(nestedKey),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nestedKey, nested]) => [
          nestedKey,
          normalizeValue(nested, workspace, nestedKey, stripExecutionMetrics),
        ]),
    )
  }
  if (typeof value === 'string') {
    if (isHostPlanApproval(value)) return '<plan-approval-host-interaction>'
    if (key === 'prefixHash') return '<prefix-hash>'
    return normalizeString(value, workspace, stripExecutionMetrics)
  }
  return value
}

const EXECUTION_METRIC_KEYS = new Set(['durationMs', 'waitedMs', 'pid'])

function normalizeString(
  value: string,
  workspace: string,
  stripExecutionMetrics = false,
): string {
  const portableWorkspace = workspace.replaceAll('\\', '/')
  const normalized = value
    .replaceAll(workspace.replaceAll('\\', '\\\\'), '<workspace>')
    .replaceAll(workspace, '<workspace>')
    .replaceAll('\\', '/')
    .replaceAll(portableWorkspace, '<workspace>')
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/gu,
      '<timestamp>',
    )
    .replace(
      /\b(?:session|run|llm|call|event)-[0-9a-f-]{16,}\b/giu,
      '<runtime-id>',
    )
    .replace(/\bplan:[0-9a-f-]{16,}\b/giu, '<plan-id>')
    .replace(
      /writer_conversation_id: [^\n]+/gu,
      'writer_conversation_id: <runtime-id>',
    )
  const trimmed = normalized.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(
        normalizeValue(
          JSON.parse(normalized) as JsonValue,
          workspace,
          '',
          stripExecutionMetrics,
        ),
      )
    } catch {
      // Preserve ordinary text that merely starts with JSON punctuation.
    }
  }
  return normalized
}

function isApprovalMessage(value: JsonValue): boolean {
  return (
    isRecord(value) &&
    value.role === 'user' &&
    value.content === '<plan-approval-host-interaction>'
  )
}

function isRuntimeMessage(value: JsonValue): boolean {
  return (
    isRecord(value) &&
    value.role === 'user' &&
    typeof value.content === 'string' &&
    value.content.startsWith('<environment_context ')
  )
}

function isHostPlanApproval(value: string): boolean {
  return (
    value.includes('<autonomous_plan_approval>') ||
    /^approve(?:d)?(?: the)? plan[.!]?$/iu.test(value.trim())
  )
}

function compareValues(
  left: JsonValue,
  right: JsonValue,
  path: string,
  differences: RuntimeParityDifference[],
): void {
  if (differences.length >= 64 || Object.is(left, right)) return
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      compareValues(
        left[index] ?? null,
        right[index] ?? null,
        `${path}[${index}]`,
        differences,
      )
    }
    return
  }
  if (isRecord(left) && isRecord(right)) {
    for (const key of [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()) {
      compareValues(
        left[key] ?? null,
        right[key] ?? null,
        path ? `${path}.${key}` : key,
        differences,
      )
    }
    return
  }
  differences.push({ path: path || '$', left, right })
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
