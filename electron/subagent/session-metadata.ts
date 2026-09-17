import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { PermissionModeSchema } from '../../shared/config/security'
import { AgentExecutionIdSchema } from '../../shared/ids'
import { ModelSelectionSchema } from '../../shared/model-route'
import type { SessionRecord } from '../../shared/session'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { FrozenSubagentToolContext } from './contracts'

const MetadataSchema = Type.Object(
  {
    initialExecutionId: AgentExecutionIdSchema,
    delegation: Type.Optional(
      Type.Object(
        {
          permissionMode: PermissionModeSchema,
          allowedToolIds: Type.Array(
            Type.String({ minLength: 1, maxLength: 512 }),
            { maxItems: 4096, uniqueItems: true },
          ),
          gitToolsEnabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type AgentSessionMetadata = Static<typeof MetadataSchema>

/** Validates persisted private metadata without inventing permissions for older Sessions. */
export function parseAgentSessionMetadata(
  value: unknown,
): AgentSessionMetadata {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!Value.Check(MetadataSchema, parsed))
    throw new Error('Invalid child Session metadata')
  return structuredClone(parsed)
}

/** Serializes the frozen delegation ceiling without model credentials or live objects. */
export function agentSessionMetadata(
  initialExecutionId: AgentSessionMetadata['initialExecutionId'],
  context: FrozenSubagentToolContext,
): AgentSessionMetadata {
  return parseAgentSessionMetadata({
    initialExecutionId,
    delegation: {
      ...context,
      allowedToolIds: [...context.allowedToolIds].sort(),
    },
  })
}

/** Creates empty durable child identity before any worker or Provider request is started. */
export function childSessionRecord(
  parent: SessionRecord,
  execution: SubagentExecutionRecord,
  metadata: AgentSessionMetadata,
): SessionRecord {
  const route =
    execution.route &&
    typeof execution.route === 'object' &&
    !Array.isArray(execution.route)
      ? execution.route.main
      : undefined
  if (
    !execution.childSessionId ||
    !metadata.delegation ||
    !route ||
    typeof route !== 'object' ||
    Array.isArray(route)
  )
    throw new Error('Child Session has no valid delegation')
  const selection = {
    providerId: route.providerId,
    model: route.model,
    reasoning: route.reasoning,
  }
  if (!Value.Check(ModelSelectionSchema, selection))
    throw new Error('Child model selection is invalid')
  return {
    schemaVersion: 1,
    id: execution.childSessionId,
    projectId: parent.projectId,
    title: `Subagent: ${execution.name}`.slice(0, 256),
    titleSource: 'user',
    lifecycle: 'active',
    permissionMode: metadata.delegation.permissionMode,
    modelSelection: selection,
    goal: null,
    plan: null,
    revision: 1,
    lastSeq: 0,
    createdAt: execution.createdAt,
    updatedAt: execution.createdAt,
  }
}
