import type { PublicConfig } from '../../shared/config'
import type { SwarmToolConfiguration } from './session-types'

export interface SwarmAvailability {
  toolConfig?: SwarmToolConfiguration
  unavailableReason?: string
}

/** Resolves whether a public Run may expose the ordinary Swarm Tool. */
export function resolveSwarmAvailability(input: {
  hostEnabled: boolean
  runSubagentsEnabled: boolean
  config: {
    limits: Pick<PublicConfig['limits'], 'maxConcurrentRuns'>
    models: Pick<PublicConfig['models'], 'modelPool'>
    subagents: Pick<PublicConfig['subagents'], 'maxAgentsPerSwarm'>
  }
  requestedGoal?: string
}): SwarmAvailability {
  if (!input.hostEnabled) {
    return { unavailableReason: 'Swarm is not available in this runtime host.' }
  }
  if (!input.runSubagentsEnabled) {
    return {
      unavailableReason: 'Subagents must be enabled before starting a Swarm.',
    }
  }
  if (input.config.limits.maxConcurrentRuns < 2) {
    return {
      unavailableReason: 'Swarm requires maxConcurrentRuns to be at least 2.',
    }
  }
  if (!input.config.models.modelPool.entries.some((entry) => entry.enabled)) {
    return {
      unavailableReason:
        'Swarm requires at least one enabled model-pool route.',
    }
  }
  return {
    toolConfig: {
      maxAgentsPerJob: input.config.subagents.maxAgentsPerSwarm,
      ...(input.requestedGoal ? { goal: input.requestedGoal } : {}),
    },
  }
}
