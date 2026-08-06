import { createHash } from 'node:crypto'
import type {
  ModelCapabilityLevel,
  ProviderPublicConfig,
  PublicConfig,
} from '../../shared/config'
import {
  MODEL_POOL_PLAN_SCHEMA_VERSION,
  type ModelPoolPlanSnapshot,
} from '../../shared/model-pool-plan'
import type { ModelSelection } from '../../shared/model-route'
import type { ConfigStore } from '../config/store'
import {
  resolveModelRoutePairFromConfig,
  type ResolvedModelRoutePair,
} from '../providers/model-route-resolver'
import {
  planModelPoolAssignments,
  type ModelPoolAssignment,
  type ModelPoolCandidate,
} from './allocator'

type RoutePairResolver = (
  configStore: ConfigStore,
  config: PublicConfig,
  selection: ModelSelection,
) => Promise<ResolvedModelRoutePair>

export interface FreezeModelPoolPlanOptions {
  resolveRoutePair?: RoutePairResolver
}

export interface PreparedModelPoolAssignment extends ModelPoolAssignment {
  routes: ResolvedModelRoutePair
}

export interface PreparedModelPoolPlan {
  assignments: PreparedModelPoolAssignment[]
  safeSnapshot: ModelPoolPlanSnapshot
}

function enabledProvider(
  config: PublicConfig,
  providerId: string,
): ProviderPublicConfig {
  const provider = config.providers.find(
    (candidate) => candidate.id === providerId,
  )
  if (!provider) {
    throw new Error(`Provider is not configured: ${providerId}`)
  }
  return provider
}

function enabledPoolCandidates(config: PublicConfig): ModelPoolCandidate[] {
  return config.modelPool.entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const provider = enabledProvider(config, entry.providerId)
      const capability = provider.modelOverrides[entry.model]?.capability
      if (!capability) {
        throw new Error(
          `Model ${entry.model} has no capability annotation for model pool entry ${entry.id}`,
        )
      }
      return {
        ...entry,
        capability,
      }
    })
}

function poolState(
  config: PublicConfig,
  candidates: readonly ModelPoolCandidate[],
): {
  digest: string
  providerRevisions: Array<{ providerId: string; revision: number }>
} {
  const revisions = new Map<string, number>()
  const entries = candidates.map((entry) => {
    const provider = enabledProvider(config, entry.providerId)
    revisions.set(provider.id, provider.revision)
    return {
      id: entry.id,
      providerId: entry.providerId,
      providerRevision: provider.revision,
      model: entry.model,
      reasoning: entry.reasoning,
      capability: entry.capability,
      maxParallel: entry.maxParallel,
    }
  })
  return {
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: MODEL_POOL_PLAN_SCHEMA_VERSION,
          entries,
        }),
      )
      .digest('hex'),
    providerRevisions: [...revisions].map(([providerId, revision]) => ({
      providerId,
      revision,
    })),
  }
}

/** Freezes deterministic model-pool assignments into private routes and a safe snapshot. */
export async function freezeModelPoolPlan(
  configStore: ConfigStore,
  requirements: readonly ModelCapabilityLevel[],
  options: FreezeModelPoolPlanOptions = {},
): Promise<PreparedModelPoolPlan> {
  const config = configStore.getPublicConfig()
  const candidates = enabledPoolCandidates(config)
  const assignments = planModelPoolAssignments(candidates, requirements)
  const state = poolState(config, candidates)
  const resolveRoutePair =
    options.resolveRoutePair ?? resolveModelRoutePairFromConfig
  const routesByEntry = new Map<string, Promise<ResolvedModelRoutePair>>()

  for (const assignment of assignments) {
    if (routesByEntry.has(assignment.entryId)) continue
    routesByEntry.set(
      assignment.entryId,
      resolveRoutePair(configStore, config, {
        providerId: assignment.providerId,
        model: assignment.model,
        reasoning: assignment.reasoning,
      }),
    )
  }

  const resolvedRoutes = new Map<string, ResolvedModelRoutePair>()
  await Promise.all(
    [...routesByEntry].map(async ([entryId, routePromise]) => {
      resolvedRoutes.set(entryId, await routePromise)
    }),
  )
  configStore.assertProviderRevisions(state.providerRevisions)

  const preparedAssignments = assignments.map((assignment) => ({
    ...assignment,
    routes: resolvedRoutes.get(assignment.entryId)!,
  }))
  const safeSnapshot: ModelPoolPlanSnapshot = {
    schemaVersion: MODEL_POOL_PLAN_SCHEMA_VERSION,
    poolDigest: state.digest,
    assignments: preparedAssignments.map((assignment) => ({
      requirementIndex: assignment.requirementIndex,
      requestedCapability: assignment.requestedCapability,
      entryId: assignment.entryId,
      capability: assignment.capability,
      providerId: assignment.providerId,
      model: assignment.model,
      reasoning: assignment.reasoning,
      providerRevision: assignment.routes.main.snapshot.providerConfigRevision,
      maxParallel: assignment.maxParallel,
      routes: {
        main: structuredClone(assignment.routes.main.snapshot),
        compression: structuredClone(assignment.routes.compression.snapshot),
      },
    })),
  }

  return {
    assignments: preparedAssignments,
    safeSnapshot,
  }
}
