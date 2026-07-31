import type { ProviderToolDefinition } from '../providers/provider'
import type { ToolRegistry } from '../tools/tool-registry'

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
const GIT_READ_ONLY_TOOL_IDS = new Set([
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
])

export interface SessionToolCatalog {
  definitions: ProviderToolDefinition[]
  names: string[]
}

/** Resolves the provider-visible tool catalog for one workspace. */
export function resolveSessionToolCatalog(input: {
  registry: ToolRegistry
  allowedToolIds?: ReadonlySet<string>
  subagentsEnabled?: boolean
  gitToolsEnabled?: boolean
}): SessionToolCatalog {
  const definitions = input.registry
    .providerDefinitions()
    .filter(
      (definition) =>
        !DISABLED_PROJECT_TOOL_IDS.has(definition.name) &&
        (!input.allowedToolIds || input.allowedToolIds.has(definition.name)) &&
        (input.subagentsEnabled || definition.name !== 'subagent_run') &&
        (input.gitToolsEnabled !== false ||
          !GIT_READ_ONLY_TOOL_IDS.has(definition.name)),
    )
  return {
    definitions,
    names: definitions.map((definition) => definition.name),
  }
}
