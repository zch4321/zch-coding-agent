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
  maxParallel: number
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

/** Assigns capability requirements deterministically with per-tier round robin. */
export function planModelPoolAssignments(
  entries: readonly ModelPoolCandidate[],
  requirements: readonly ModelCapabilityLevel[],
): ModelPoolAssignment[] {
  const tiers = new Map<ModelCapabilityLevel, readonly ModelPoolCandidate[]>(
    CAPABILITY_ORDER.map((capability) => [
      capability,
      entries.filter(
        (entry) => entry.enabled && entry.capability === capability,
      ),
    ]),
  )
  const selectedTiers = requirements.map((required, requirementIndex) => {
    const minimumIndex = CAPABILITY_ORDER.indexOf(required)
    const selected = CAPABILITY_ORDER.slice(minimumIndex).find(
      (capability) => (tiers.get(capability)?.length ?? 0) > 0,
    )
    if (!selected) {
      throw new ModelPoolAllocationError(requirementIndex, required)
    }
    return selected
  })
  const cursors = new Map<ModelCapabilityLevel, number>()

  return selectedTiers.map((capability, requirementIndex) => {
    const candidates = tiers.get(capability)!
    const cursor = cursors.get(capability) ?? 0
    const entry = candidates[cursor % candidates.length]!
    cursors.set(capability, cursor + 1)
    return {
      requirementIndex,
      requestedCapability: requirements[requirementIndex]!,
      entryId: entry.id,
      capability: entry.capability,
      providerId: entry.providerId,
      model: entry.model,
      reasoning: entry.reasoning,
      maxParallel: entry.maxParallel,
    }
  })
}
