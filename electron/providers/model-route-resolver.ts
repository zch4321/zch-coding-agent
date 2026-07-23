import type { ProviderPublicConfig, PublicConfig } from '../../shared/config'
import { getProviderConfig } from '../../shared/config'
import type {
  ModelRouteSnapshot,
  ModelSelection,
  ProviderPurpose,
} from '../../shared/model-route'
import type { ConfigStore } from '../config/store'

export interface ResolvedModelRoute {
  snapshot: ModelRouteSnapshot
  provider: ProviderPublicConfig
  apiKey: string
}

function endpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('chat/completions', normalized).toString()
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
  const apiKey = await configStore.getProviderApiKeyForRevision(
    provider.id,
    provider.revision,
  )
  if (!apiKey) {
    throw new Error(`${provider.label} credential is not available`)
  }
  return {
    snapshot: {
      schemaVersion: 1,
      purpose,
      adapterId: provider.adapterId,
      providerId: provider.id,
      model: selection.model,
      reasoning: selection.reasoning,
      endpoint: endpoint(provider.baseURL),
      providerConfigRevision: provider.revision,
    },
    provider: structuredClone(provider),
    apiKey,
  }
}

export async function resolveRunRoutes(
  configStore: ConfigStore,
  selection: ModelSelection,
): Promise<{
  main: ResolvedModelRoute
  compression: ResolvedModelRoute
  approval: ResolvedModelRoute
}> {
  const config = configStore.getPublicConfig()
  const approvalProvider = getProviderConfig(
    config,
    config.approval.approverProviderId,
  )
  if (!approvalProvider) {
    throw new Error(
      `Approval Provider is not configured: ${config.approval.approverProviderId}`,
    )
  }
  const approvalSelection: ModelSelection = {
    providerId: approvalProvider.id,
    model: config.approval.approverModel,
    reasoning:
      approvalProvider.reasoning === 'off'
        ? 'high'
        : approvalProvider.reasoning,
  }
  const [main, compression, approval] = await Promise.all([
    resolve(configStore, config, selection, 'main'),
    resolve(configStore, config, selection, 'compression'),
    resolve(configStore, config, approvalSelection, 'approval'),
  ])
  return { main, compression, approval }
}
