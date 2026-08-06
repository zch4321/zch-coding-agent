import type { ModelCapabilityLevel } from '../../shared/config'
import type { ModelPoolEntry } from '../../shared/model-pool'

const CAPABILITY_ORDER: readonly ModelCapabilityLevel[] = [
  'light',
  'standard',
  'strong',
]

/** Combines a persisted pool route with its Provider-owned capability annotation. */
export interface ModelPoolCandidate extends ModelPoolEntry {
  capability: ModelCapabilityLevel
}

export interface ModelPoolAssignment {
  requirementIndex: number
  requestedCapability: ModelCapabilityLevel
  entryId: string
  capability: ModelCapabilityLevel
  providerId: string
  model: string
  reasoning: ModelPoolEntry['reasoning']
}

interface ModelCandidateGroup {
  key: string
  capability: ModelCapabilityLevel
  routes: ModelPoolCandidate[]
}

/** Reports that no enabled pool entry can meet one capability requirement. */
export class ModelPoolAllocationError extends Error {
  constructor(
    readonly requirementIndex: number,
    readonly capability: ModelCapabilityLevel,
  ) {
    super(
      `Model pool cannot satisfy ${capability} requirement at index ${requirementIndex}`,
    )
    this.name = 'ModelPoolAllocationError'
  }
}

function groupEnabledModels(
  entries: readonly ModelPoolCandidate[],
): ModelCandidateGroup[] {
  const groups = new Map<string, ModelCandidateGroup>()
  const routeKeys = new Map<string, Set<ModelPoolEntry['reasoning']>>()

  for (const entry of entries) {
    if (!entry.enabled) continue
    const key = JSON.stringify([entry.providerId, entry.model])
    let group = groups.get(key)
    if (!group) {
      group = { key, capability: entry.capability, routes: [] }
      groups.set(key, group)
      routeKeys.set(key, new Set())
    } else if (group.capability !== entry.capability) {
      throw new Error(
        `Model pool has conflicting capabilities for ${entry.providerId}/${entry.model}`,
      )
    }

    const reasoning = routeKeys.get(key)!
    if (reasoning.has(entry.reasoning)) continue
    reasoning.add(entry.reasoning)
    group.routes.push(entry)
  }

  return [...groups.values()]
}

function capabilitySatisfies(
  actual: ModelCapabilityLevel,
  required: ModelCapabilityLevel,
): boolean {
  return CAPABILITY_ORDER.indexOf(actual) >= CAPABILITY_ORDER.indexOf(required)
}

/** Assigns requirements by cycling satisfying models, then their exact routes. */
export function planModelPoolAssignments(
  entries: readonly ModelPoolCandidate[],
  requirements: readonly ModelCapabilityLevel[],
): ModelPoolAssignment[] {
  const models = groupEnabledModels(entries)
  const eligibleModels = new Map(
    CAPABILITY_ORDER.map((required) => [
      required,
      models.filter((model) => capabilitySatisfies(model.capability, required)),
    ]),
  )
  for (const [requirementIndex, required] of requirements.entries()) {
    if ((eligibleModels.get(required)?.length ?? 0) === 0) {
      throw new ModelPoolAllocationError(requirementIndex, required)
    }
  }

  const modelCursors = new Map<ModelCapabilityLevel, number>()
  const routeCursors = new Map<string, number>()

  return requirements.map((required, requirementIndex) => {
    const candidates = eligibleModels.get(required)!
    const modelCursor = modelCursors.get(required) ?? 0
    const selectedModel = candidates[modelCursor % candidates.length]!
    modelCursors.set(required, modelCursor + 1)

    const routeCursor = routeCursors.get(selectedModel.key) ?? 0
    const entry =
      selectedModel.routes[routeCursor % selectedModel.routes.length]!
    routeCursors.set(selectedModel.key, routeCursor + 1)

    return {
      requirementIndex,
      requestedCapability: required,
      entryId: entry.id,
      capability: entry.capability,
      providerId: entry.providerId,
      model: entry.model,
      reasoning: entry.reasoning,
    }
  })
}
