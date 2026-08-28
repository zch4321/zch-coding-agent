import type { ProviderToolDefinition } from '../providers/provider'
import type { ToolRegistry } from '../tools/tool-registry'
import { isGitReadOnlyToolId } from '../tools/git-tool-ids'

const DISABLED_PROJECT_TOOL_IDS = new Set([
  'project_get_modules',
  'project_detect_modules',
  'project_set_modules',
  'project_update_module',
  'code_symbol_overview',
  'code_find_definition',
  'code_find_references',
  'code_workspace_symbols',
  'code_diagnostics',
])
export interface SessionToolCatalog {
  definitions: ProviderToolDefinition[]
  names: string[]
}

function freezeSwarmLimit(
  definition: ProviderToolDefinition,
  maximum: number | undefined,
): ProviderToolDefinition {
  if (definition.name !== 'swarm_run' || maximum === undefined) {
    return definition
  }
  const limited = structuredClone(definition)
  const schema = limited.inputSchema as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown> | undefined
  const tasks = properties?.tasks as Record<string, unknown> | undefined
  const items = tasks?.items as Record<string, unknown> | undefined
  const taskProperties = items?.properties as
    | Record<string, unknown>
    | undefined
  const agentCount = taskProperties?.agentCount as
    | Record<string, unknown>
    | undefined
  if (tasks) tasks.maxItems = maximum
  if (agentCount) agentCount.maximum = maximum
  return limited
}

/** Resolves the provider-visible tool catalog for one workspace. */
export function resolveSessionToolCatalog(input: {
  registry: ToolRegistry
  allowedToolIds?: ReadonlySet<string>
  subagentsEnabled?: boolean
  swarmEnabled?: boolean
  maxSubagents?: number
  gitToolsEnabled?: boolean
}): SessionToolCatalog {
  const definitions = input.registry
    .providerDefinitions()
    .filter(
      (definition) =>
        !DISABLED_PROJECT_TOOL_IDS.has(definition.name) &&
        (!input.allowedToolIds || input.allowedToolIds.has(definition.name)) &&
        (input.subagentsEnabled || definition.name !== 'subagent_run') &&
        (input.swarmEnabled || definition.name !== 'swarm_run') &&
        (input.subagentsEnabled || definition.name !== 'swarm_run') &&
        (input.gitToolsEnabled !== false ||
          !isGitReadOnlyToolId(definition.name)),
    )
    .map((definition) => freezeSwarmLimit(definition, input.maxSubagents))
  return {
    definitions,
    names: definitions.map((definition) => definition.name),
  }
}
