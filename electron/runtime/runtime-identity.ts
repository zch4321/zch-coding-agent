import { createHash } from 'node:crypto'
import type { PublicConfig } from '../../shared/config'
import type { RuntimeIdentity } from '../../shared/runtime-identity'
import type { AgentRuntime } from './agent-runtime'

declare const __ZCH_SOURCE_COMMIT__: string | undefined
declare const __ZCH_SOURCE_TREE_STATE__:
  | RuntimeIdentity['sourceTree']
  | undefined

/** Computes a SHA-256 digest from a JSON-serialized value. */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Builds runtime identity from configuration, task digest, source, and runtime metadata. */
export function createRuntimeIdentity(input: {
  runtime: AgentRuntime
  config: PublicConfig
  configHash: string
  taskDigest: string
  sourceCommit?: string
  sourceTree?: RuntimeIdentity['sourceTree']
  runtimeImageDigest?: string
  platform?: string
  arch?: string
  nodeVersion?: string
}): RuntimeIdentity {
  const provider =
    input.config.providers.find(
      (candidate) => candidate.id === input.config.activeProviderId,
    ) ?? input.config.providers[0]!
  const toolDefinitions =
    input.runtime.services.sessions.providerToolDefinitions()
  const toolNames = input.runtime.services.sessions.toolNames()
  return {
    schemaVersion: 4,
    sourceCommit: input.sourceCommit?.trim() || embeddedSourceCommit(),
    sourceTree: input.sourceTree ?? embeddedSourceTree(),
    runtimeImageDigest:
      input.runtimeImageDigest?.trim() ||
      process.env.ZCH_RUNTIME_IMAGE_DIGEST?.trim() ||
      'local',
    taskDigest: input.taskDigest,
    configHash: input.configHash,
    toolsHash: sha256Json(toolDefinitions),
    promptResources: input.runtime.services.prompts
      .list()
      .map(({ id, version, sha256 }) => ({ id, version, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    provider: {
      id: provider.id,
      providerType: provider.providerType,
      model: provider.model,
      reasoning: provider.reasoning,
    },
    budgets: {
      maxStepsPerRun: input.config.limits.maxStepsPerRun,
      maxContextTokens: input.config.limits.maxContextTokens,
      maxToolResultTokens: input.config.limits.maxToolResultTokens,
      maxToolOutputBytes: input.config.limits.maxToolOutputBytes,
      commandTimeoutMs: input.config.limits.commandTimeoutMs,
      subagentWorkerTimeoutMs: input.config.subagents.workerTimeoutMs,
    },
    capabilities: {
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      nodeVersion: input.nodeVersion ?? process.version,
      permissionMode: 'yolo',
      skillsEnabled: input.config.skills.enabled,
      subagentsEnabled: input.config.subagents.enabled,
      mcpServerIds: input.config.mcpServers
        .filter((server) => server.enabled)
        .map((server) => server.id)
        .sort(),
      mcpServers: input.runtime.services.mcp
        .listStatuses()
        .map(({ id, state, trusted, toolCount, revision }) => ({
          id,
          state,
          trusted,
          toolCount,
          ...(revision ? { revision } : {}),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      toolNames,
    },
  }
}

function embeddedSourceCommit(): string {
  if (
    typeof __ZCH_SOURCE_COMMIT__ !== 'undefined' &&
    __ZCH_SOURCE_COMMIT__.trim()
  ) {
    return __ZCH_SOURCE_COMMIT__.trim()
  }
  return process.env.ZCH_SOURCE_COMMIT?.trim() || 'development'
}

function embeddedSourceTree(): RuntimeIdentity['sourceTree'] {
  if (
    typeof __ZCH_SOURCE_TREE_STATE__ !== 'undefined' &&
    (__ZCH_SOURCE_TREE_STATE__ === 'clean' ||
      __ZCH_SOURCE_TREE_STATE__ === 'dirty')
  ) {
    return __ZCH_SOURCE_TREE_STATE__
  }
  return 'unknown'
}
