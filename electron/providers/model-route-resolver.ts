import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import { getProviderConfig } from '../../shared/config'
import type {
  ModelRouteSnapshot,
  ModelSelection,
  ProviderPurpose,
} from '../../shared/model-route'
import { assertModelRouteSnapshotSafe } from '../../shared/model-route'
import type { ConfigStore } from '../config/store'
import { resolveModelProfiles, type ModelProfile } from './model-catalog'
import { resolveProviderEndpoint } from './provider-factory'

export interface ResolvedModelRoute {
  snapshot: ModelRouteSnapshot
  provider: ProviderPublicConfig
  modelProfile: ModelProfile
  apiKey: string
}

export interface ResolvedModelRoutePair {
  main: ResolvedModelRoute
  compression: ResolvedModelRoute
}

interface ResolvedModelBinding {
  selection: ModelSelection
  endpoint: string
  provider: ProviderPublicConfig
  modelProfile: ModelProfile
  apiKey: string
}

async function resolveBinding(
  configStore: ConfigStore,
  config: PublicConfig,
  selection: ModelSelection,
): Promise<ResolvedModelBinding> {
  const provider = getProviderConfig(config, selection.providerId)
  if (!provider) {
    throw new Error(`Provider is not configured: ${selection.providerId}`)
  }
  if (!selection.model || !provider.enabledModelIds.includes(selection.model)) {
    throw new Error(
      `Model is not enabled for ${provider.label}: ${selection.model || '(none)'}`,
    )
  }
  const endpoint = resolveProviderEndpoint(
    provider.providerType,
    provider.baseURL,
  )
  assertModelRouteSnapshotSafe({
    schemaVersion: 2,
    purpose: 'main',
    providerType: provider.providerType,
    providerId: provider.id,
    model: selection.model,
    reasoning: selection.reasoning,
    endpoint,
    providerConfigRevision: provider.revision,
  })
  const supportedEfforts =
    provider.modelOverrides[selection.model]?.reasoningEfforts
  if (
    supportedEfforts?.length &&
    !supportedEfforts.includes(selection.reasoning)
  ) {
    throw new Error(
      `Model ${selection.model} does not support reasoning effort '${selection.reasoning}' (supported: ${supportedEfforts.join(', ')})`,
    )
  }
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
    selection: structuredClone(selection),
    endpoint,
    provider: structuredClone(provider),
    modelProfile: structuredClone(modelProfile),
    apiKey,
  }
}

function resolvedRoute(
  binding: ResolvedModelBinding,
  purpose: ProviderPurpose,
): ResolvedModelRoute {
  return {
    snapshot: {
      schemaVersion: 2,
      purpose,
      providerType: binding.provider.providerType,
      providerId: binding.provider.id,
      model: binding.selection.model,
      reasoning: binding.selection.reasoning,
      endpoint: binding.endpoint,
      providerConfigRevision: binding.provider.revision,
    },
    provider: structuredClone(binding.provider),
    modelProfile: structuredClone(binding.modelProfile),
    apiKey: binding.apiKey,
  }
}

async function resolveRoute(
  configStore: ConfigStore,
  config: PublicConfig,
  selection: ModelSelection,
  purpose: ProviderPurpose,
): Promise<ResolvedModelRoute> {
  return resolvedRoute(
    await resolveBinding(configStore, config, selection),
    purpose,
  )
}

/** Resolves one main/compression pair from exactly the supplied public-config snapshot. */
export async function resolveModelRoutePairFromConfig(
  configStore: ConfigStore,
  config: PublicConfig,
  selection: ModelSelection,
): Promise<ResolvedModelRoutePair> {
  const binding = await resolveBinding(configStore, config, selection)
  return {
    main: resolvedRoute(binding, 'main'),
    compression: resolvedRoute(binding, 'compression'),
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
  const { main, compression } = await resolveModelRoutePairFromConfig(
    configStore,
    config,
    selection,
  )
  if (!approvalProvider) {
    options.onDiagnostic?.(
      `Approval Provider is not configured: ${config.approval.approverProviderId}`,
    )
    return { main, compression }
  }
  const approvalSelection: ModelSelection = {
    providerId: approvalProvider.id,
    model: config.approval.approverModel,
    // Deliberate exception to the no-auto-adjust rule: approval is an internal
    // safety gate whose effort is never user-selected, so 'off' raises to 'high'.
    reasoning:
      approvalProvider.reasoning === 'off'
        ? 'high'
        : approvalProvider.reasoning,
  }
  try {
    return {
      main,
      compression,
      approval: await resolveRoute(
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
