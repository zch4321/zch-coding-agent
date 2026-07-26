import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import { getProviderConfig } from '../../shared/config'
import type {
  ModelRouteSnapshot,
  ModelSelection,
  ProviderPurpose,
} from '../../shared/model-route'
import {
  assertModelRouteSnapshotSafe,
  resolveChatCompletionsEndpoint,
} from '../../shared/model-route'
import type { ConfigStore } from '../config/store'
import { resolveModelProfiles, type ModelProfile } from './model-catalog'

export interface ResolvedModelRoute {
  snapshot: ModelRouteSnapshot
  provider: ProviderPublicConfig
  modelProfile: ModelProfile
  apiKey: string
}

async function resolve(
  configStore: ConfigStore,
  config: PublicConfig,
  selection: ModelSelection,
  purpose: ProviderPurpose,
): Promise<ResolvedModelRoute> {
  const provider = getProviderConfig(config, selection.providerId)
  if (!provider) {
    throw new Error(`Provider is not configured: ${selection.providerId}`)
  }
  const snapshot: ModelRouteSnapshot = {
    schemaVersion: 1,
    purpose,
    adapterId: provider.adapterId,
    providerId: provider.id,
    model: selection.model,
    reasoning: selection.reasoning,
    endpoint: resolveChatCompletionsEndpoint(provider.baseURL),
    providerConfigRevision: provider.revision,
  }
  assertModelRouteSnapshotSafe(snapshot)
  const modelProfile = resolveModelProfiles(
    config,
    provider.id,
    selection.model,
  ).find((candidate) => candidate.id === selection.model)!
  const apiKey = await configStore.getProviderApiKeyForRevision(
    provider.id,
    provider.revision,
  )
  if (!apiKey) {
    throw new Error(`${provider.label} credential is not available`)
  }
  return {
    snapshot,
    provider: structuredClone(provider),
    modelProfile: structuredClone(modelProfile),
    apiKey,
  }
}

/**
 * Freezes the main and compression routes for a run while treating the
 * automatic-approval route as an optional enhancement.
 */
export async function resolveRunRoutes(
  configStore: ConfigStore,
  selection: ModelSelection,
  options: {
    onDiagnostic?: (message: string, error?: unknown) => void
  } = {},
): Promise<{
  main: ResolvedModelRoute
  compression: ResolvedModelRoute
  approval?: ResolvedModelRoute
}> {
  const config = configStore.getPublicConfig()
  const approvalProvider = getProviderConfig(
    config,
    config.approval.approverProviderId,
  )
  const [main, compression] = await Promise.all([
    resolve(configStore, config, selection, 'main'),
    resolve(configStore, config, selection, 'compression'),
  ])
  if (!approvalProvider) {
    options.onDiagnostic?.(
      `Approval Provider is not configured: ${config.approval.approverProviderId}`,
    )
    return { main, compression }
  }
  const approvalSelection: ModelSelection = {
    providerId: approvalProvider.id,
    model: config.approval.approverModel,
    reasoning:
      approvalProvider.reasoning === 'off'
        ? 'high'
        : approvalProvider.reasoning,
  }
  try {
    return {
      main,
      compression,
      approval: await resolve(
        configStore,
        config,
        approvalSelection,
        'approval',
      ),
    }
  } catch (error) {
    options.onDiagnostic?.(
      'Automatic approval route is unavailable; human approval remains enabled',
      error,
    )
    return { main, compression }
  }
}
