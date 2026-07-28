import type { ProjectModel } from '../../shared/project-model'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { ProviderToolDefinition } from '../providers/provider'
import { CODE_INTELLIGENCE_TOOL_IDS } from '../tools/code-intelligence-tools'
import type { ToolRegistry } from '../tools/tool-registry'

const CODE_INTELLIGENCE_TOOL_ID_SET = new Set<string>(
  CODE_INTELLIGENCE_TOOL_IDS,
)

export interface SessionToolCatalog {
  definitions: ProviderToolDefinition[]
  names: string[]
}

/** Reports whether the project has an enabled Serena binding with capabilities. */
export function projectHasCodeIntelligence(
  project: Pick<ProjectModel, 'serena' | 'backendBindings'>,
): boolean {
  return (
    project.serena.enabled &&
    project.backendBindings.some(
      (binding) =>
        binding.enabled &&
        binding.backendId === project.serena.id &&
        binding.backendKind === 'serena-mcp' &&
        binding.capabilities.length > 0,
    )
  )
}

/** Resolves the provider-visible tool catalog for one workspace. */
export async function resolveSessionToolCatalog(input: {
  registry: ToolRegistry
  projectMetadata?: Pick<ProjectMetadataStore, 'get'>
  workspace: string
}): Promise<SessionToolCatalog> {
  const definitions = input.registry.providerDefinitions()
  if (
    !definitions.some((definition) =>
      CODE_INTELLIGENCE_TOOL_ID_SET.has(definition.name),
    )
  ) {
    return {
      definitions,
      names: definitions.map((definition) => definition.name),
    }
  }

  const exposeCodeIntelligence = await input.projectMetadata
    ?.get(input.workspace)
    .then((snapshot) => projectHasCodeIntelligence(snapshot.project))
    .catch(() => false)
  const visible = exposeCodeIntelligence
    ? definitions
    : definitions.filter(
        (definition) => !CODE_INTELLIGENCE_TOOL_ID_SET.has(definition.name),
      )

  return {
    definitions: visible,
    names: visible.map((definition) => definition.name),
  }
}
