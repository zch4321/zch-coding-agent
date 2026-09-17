import path from 'node:path'
import { accessPath as access } from '../common/filesystem'
import {
  artifactCaptureAvailable,
  artifactPathFor,
} from '../project-artifacts/access'
import type { JsonValue } from '../../shared/json'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { SubagentStateService } from '../application/subagent-state-service'
import type { PreparedSubagentExecutionPort } from '../subagent/contracts'
import type { SwarmExecutionPort } from '../swarm/contracts'
import type { BackgroundAgentHandleRegistry } from './agent-handle-registry'
import type { BackgroundWaitInput, BackgroundTarget } from './contracts'
interface ProjectionPorts {
  state: SubagentStateService
  subagents: PreparedSubagentExecutionPort
  swarms: SwarmExecutionPort
  handles: BackgroundAgentHandleRegistry
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
function agentTerminal(status: SubagentExecutionRecord['status']): boolean {
  return !['queued', 'preparing', 'running', 'pausing', 'paused'].includes(
    status,
  )
}
async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  )
}
function boundedError(
  error: SubagentExecutionRecord['error'],
): SubagentExecutionRecord['error'] | undefined {
  return error
    ? { code: error.code.slice(0, 128), message: error.message.slice(0, 2_048) }
    : undefined
}

function subagentResponse(record: SubagentExecutionRecord): string | undefined {
  if (
    !record.result ||
    typeof record.result !== 'object' ||
    Array.isArray(record.result)
  ) {
    return undefined
  }
  const results = record.result.results
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    return undefined
  }
  return Object.values(results).find(
    (value): value is string => typeof value === 'string',
  )
}

/** Builds the shared safe projection for background waits, discovery and lifecycle notifications. */
export async function projectAgentSnapshot(
  ports: ProjectionPorts,
  record: SubagentExecutionRecord,
  sessionTemp: BackgroundWaitInput['sessionTemp'],
  target: BackgroundTarget,
  includeResult: boolean,
): Promise<Record<string, JsonValue>> {
  const parentSessionId = record.parentSessionId
  const pendingMessages = ports.subagents.pendingMessages?.(record) ?? 0
  const runtimeStatus = ports.subagents.runtimeStatus?.(record.id)
  const status =
    pendingMessages && agentTerminal(record.status)
      ? 'queued'
      : (runtimeStatus ?? record.status)
  if (record.kind === 'swarm') {
    const manifestPath = await artifactPathFor(
      sessionTemp,
      ['swarms', record.id, 'manifest.json'],
      false,
    )
    const liveArtifact = ports.swarms.artifactStatus?.(record.id)
    const available =
      liveArtifact?.artifactAvailable !== false &&
      artifactCaptureAvailable(sessionTemp, ['swarms', record.id]) &&
      (await exists(manifestPath))
    const children = await ports.state.listChildren(parentSessionId, record.id)
    const currentChildren = await Promise.all(
      children.map(
        async (child) =>
          (await ports.subagents.currentExecution?.(
            parentSessionId,
            child.id,
          )) ?? child,
      ),
    )
    const attention = children.some(
      (child) =>
        (['queued', 'preparing', 'running'].includes(child.status) &&
          ports.subagents.runtimeStatus?.(child.id) === 'paused') ||
        child.status === 'failed',
    )
    return {
      type: 'swarm',
      needsAttention: attention,
      hasActiveChildren: currentChildren.some(
        (child) => !agentTerminal(child.status),
      ),
      id: target.id,
      name: record.name,
      status: record.status,
      terminal: agentTerminal(record.status),
      counts: json(await ports.state.executionCounts(record.id)),
      children: currentChildren.map((child, index) => ({
        initialStatus: children[index]!.status,
        target: {
          type: 'subagent' as const,
          id: ports.handles.expose({
            executionId: child.id,
            childSessionId: child.childSessionId,
            parentSessionId: child.parentSessionId,
            type: 'subagent',
          }),
        },
        ...(child.childOrdinal === undefined
          ? {}
          : { childOrdinal: child.childOrdinal }),
        name: child.name,
        status: ports.subagents.runtimeStatus?.(child.id) ?? child.status,
        terminal: agentTerminal(child.status),
        ...(boundedError(child.error)
          ? { error: boundedError(child.error) }
          : {}),
      })),
      artifactAvailable: available,
      ...(available
        ? { manifestPath: liveArtifact?.artifactPath ?? manifestPath }
        : {}),
      ...(!available
        ? {
            captureError:
              liveArtifact?.captureError ??
              'Swarm manifest is unavailable or expired',
          }
        : {}),
      ...(boundedError(record.error)
        ? { error: json(boundedError(record.error)) }
        : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
  const directory = await artifactPathFor(
    sessionTemp,
    ['subagents', record.id],
    false,
  )
  const activityPath = path.join(directory, 'activity.jsonl')
  const resultPath = path.join(directory, 'result.md')
  const activityAvailable = await exists(activityPath)
  const resultAvailable = await exists(resultPath)
  const liveArtifact = ports.subagents.artifactStatus?.(record.id)
  const artifactAvailable =
    liveArtifact?.artifactAvailable !== false &&
    artifactCaptureAvailable(sessionTemp, ['subagents', record.id]) &&
    activityAvailable
  const response =
    includeResult && !pendingMessages ? subagentResponse(record) : undefined
  const parent = record.parentExecutionId
    ? await ports.state.getExecution(parentSessionId, record.parentExecutionId)
    : undefined
  return {
    type: 'subagent',
    id: target.id,
    name: record.name,
    status,
    pendingMessages,
    terminal: agentTerminal(status),
    artifactAvailable,
    ...(artifactAvailable ? { activityPath } : {}),
    ...(resultAvailable ? { resultPath } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(parent?.kind === 'swarm'
      ? {
          parentTarget: {
            type: 'swarm',
            id: ports.handles.expose({
              executionId: parent.id,
              parentSessionId: parent.parentSessionId,
              type: 'swarm',
            }),
          },
        }
      : {}),
    ...(!artifactAvailable
      ? {
          captureError:
            liveArtifact?.captureError ??
            'Subagent activity artifact is unavailable or expired',
        }
      : {}),
    ...(boundedError(record.error)
      ? { error: json(boundedError(record.error)) }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
