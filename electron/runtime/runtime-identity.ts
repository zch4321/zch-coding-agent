import { createHash } from 'node:crypto'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type {
  RuntimeIdentity,
  RuntimeIdentityDifference,
} from '../../shared/runtime-identity'
import type { AgentRuntime } from './agent-runtime'

declare const __ZCH_SOURCE_COMMIT__: string | undefined
declare const __ZCH_SOURCE_TREE_STATE__:
  | RuntimeIdentity['sourceTree']
  | undefined

/** Reports runtime identity mismatch failures. */
export class RuntimeIdentityMismatchError extends Error {
  readonly code = 'RUNTIME_IDENTITY_MISMATCH'
  readonly differences: RuntimeIdentityDifference[]

  constructor(differences: RuntimeIdentityDifference[]) {
    super(
      `Runtime identities are not comparable: ${differences
        .map((difference) => difference.path)
        .join(', ')}`,
    )
    this.name = 'RuntimeIdentityMismatchError'
    this.differences = structuredClone(differences)
  }
}

/** Returns or updates sha256 json state. */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Creates runtime identity. */
export function createRuntimeIdentity(input: {
  runtime: AgentRuntime
  config: PublicConfig
  configHash: string
  caseDigest: string
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
    schemaVersion: 1,
    sourceCommit: input.sourceCommit?.trim() || embeddedSourceCommit(),
    sourceTree: input.sourceTree ?? embeddedSourceTree(),
    runtimeImageDigest:
      input.runtimeImageDigest?.trim() ||
      process.env.ZCH_RUNTIME_IMAGE_DIGEST?.trim() ||
      'local',
    caseDigest: input.caseDigest,
    configHash: input.configHash,
    toolsHash: sha256Json(toolDefinitions),
    promptResources: input.runtime.services.prompts
      .list()
      .map(({ id, version, sha256 }) => ({ id, version, sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    provider: {
      id: provider.id,
      protocol: provider.protocol,
      profile: provider.profile,
      model: provider.model,
      reasoning: provider.reasoning,
    },
    budgets: {
      maxStepsPerRun: input.config.limits.maxStepsPerRun,
      maxContextTokens: input.config.limits.maxContextTokens,
      maxToolResultTokens: input.config.limits.maxToolResultTokens,
      maxToolTokensPerRun: input.config.limits.maxToolTokensPerRun,
      maxToolOutputBytes: input.config.limits.maxToolOutputBytes,
      commandTimeoutMs: input.config.limits.commandTimeoutMs,
    },
    capabilities: {
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      nodeVersion: input.nodeVersion ?? process.version,
      permissionMode: 'yolo',
      skillsEnabled: input.config.skills.enabled,
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

/** Validates comparable runtime identities and throws when it is invalid. */
export function assertComparableRuntimeIdentities(
  left: RuntimeIdentity,
  right: RuntimeIdentity,
): void {
  const differences: RuntimeIdentityDifference[] = []
  compareValues(
    left as unknown as JsonValue,
    right as unknown as JsonValue,
    '',
    differences,
  )
  if (differences.length > 0)
    throw new RuntimeIdentityMismatchError(differences)
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

function compareValues(
  left: JsonValue,
  right: JsonValue,
  path: string,
  differences: RuntimeIdentityDifference[],
): void {
  if (differences.length >= 64) return
  if (Object.is(left, right)) return
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
