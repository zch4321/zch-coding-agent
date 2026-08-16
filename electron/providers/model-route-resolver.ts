import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import {
  getAuxiliaryModelSelection,
  getProviderConfig,
} from '../../shared/config'
import type {
  ModelRouteSnapshot,
  ModelSelection,
  ProviderPurpose,
} from '../../shared/model-route'
import {
  assertModelRouteSnapshotSafe,
  evaluateModelRouteCompatibility,
} from '../../shared/model-route'
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
  const compatibility = evaluateModelRouteCompatibility(provider, selection)
  if (!compatibility.ok) {
    if (
      compatibility.reason === 'model-empty' ||
      compatibility.reason === 'model-disabled'
    ) {
      throw new Error(
        `Model is not enabled for ${provider.label}: ${selection.model || '(none)'}`,
      )
    }
    if (compatibility.reason === 'provider-missing') {
      throw new Error(`Provider is not configured: ${selection.providerId}`)
    }
    throw new Error(
      `Model ${selection.model} does not support reasoning effort '${selection.reasoning}' (supported: ${compatibility.supportedReasoningEfforts.join(', ')})`,
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
 * Freezes the main and compression routes for a run. The automatic-approval
 * route uses the configured auxiliary model and falls back to the run's own
 * main model when the auxiliary role is unset or unavailable.
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
  const { main, compression } = await resolveModelRoutePairFromConfig(
    configStore,
    config,
    selection,
  )
  const auxiliary = getAuxiliaryModelSelection(config)
  if (!auxiliary) {
    return {
      main,
      compression,
      approval: await resolveRoute(configStore, config, selection, 'approval'),
    }
  }
  try {
    return {
      main,
      compression,
      approval: await resolveRoute(configStore, config, auxiliary, 'approval'),
    }
  } catch (error) {
    options.onDiagnostic?.(
      'Auxiliary model route is unavailable; approval uses the current model',
      error,
    )
    return {
      main,
      compression,
      approval: await resolveRoute(configStore, config, selection, 'approval'),
    }
  }
}
