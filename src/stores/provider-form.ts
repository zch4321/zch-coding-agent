import type {
  ProviderPublicConfig,
  ProviderType,
  ReasoningEffort,
} from '../../shared/config'
import { normalizeReasoningEfforts } from '../../shared/model-settings'
import { evaluateModelRouteCompatibility } from '../../shared/model-route'
import type { UiModelProfile } from './agent-types'

export const DEFAULT_PROVIDER_FORM = {
  providerId: 'deepseek',
  label: 'DeepSeek',
  providerType: 'deepseek.chat-completions' as ProviderType,
  baseURL: 'https://api.deepseek.com',
  model: '',
  enabledModelIds: [] as string[],
  apiKey: '',
}

export type ProviderForm = typeof DEFAULT_PROVIDER_FORM

/** True when a model row carries per-model annotation beyond token overrides. */
function hasModelAnnotation(model: UiModelProfile): boolean {
  return Boolean(model.reasoningEfforts?.length || model.capability)
}

/**
 * Serializes model rows that carry token overrides or per-model annotations.
 * Token fields are written only for explicit token overrides so annotation-only
 * rows do not freeze resolved token defaults into the saved configuration.
 */
export function providerModelOverrides(
  models: UiModelProfile[],
): ProviderPublicConfig['modelOverrides'] {
  return Object.fromEntries(
    models
      .filter(
        (model) =>
          model.capabilitySource === 'override' || hasModelAnnotation(model),
      )
      .map((model) => [
        model.id,
        {
          ...(model.capabilitySource === 'override'
            ? {
                contextWindowTokens: model.contextWindowTokens,
                compactThresholdTokens: model.compactThresholdTokens,
                maxOutputTokens: model.maxOutputTokens,
              }
            : {}),
          ...(model.reasoningEfforts?.length
            ? {
                reasoningEfforts: normalizeReasoningEfforts(
                  model.reasoningEfforts,
                ),
              }
            : {}),
          ...(model.capability ? { capability: model.capability } : {}),
        },
      ]),
  )
}

/**
 * Computes whether this Provider draft would break the saved auxiliary route.
 * The role's explicit reasoning is never auto-adjusted; the user resolves an
 * incompatible model annotation or enabled-model selection manually.
 */
export function providerDraftAuxiliaryConflict(input: {
  providerId: string
  enabledModelIds: readonly string[]
  profiles: ReadonlyArray<Pick<UiModelProfile, 'id' | 'reasoningEfforts'>>
  auxiliary: {
    providerId: string
    model: string
    reasoning: ReasoningEffort
  }
}): {
  conflict: boolean
  reason: 'model-disabled' | 'reasoning-unsupported' | null
} {
  const provider = {
    enabledModelIds: input.enabledModelIds,
    modelOverrides: Object.fromEntries(
      input.profiles.map((model) => [
        model.id,
        { reasoningEfforts: model.reasoningEfforts },
      ]),
    ),
  }
  if (
    input.auxiliary.providerId !== input.providerId ||
    !input.auxiliary.model
  ) {
    return { conflict: false, reason: null }
  }
  const auxiliaryCompatibility = evaluateModelRouteCompatibility(provider, {
    model: input.auxiliary.model,
    reasoning: input.auxiliary.reasoning,
  })
  if (
    !auxiliaryCompatibility.ok &&
    (auxiliaryCompatibility.reason === 'model-empty' ||
      auxiliaryCompatibility.reason === 'model-disabled')
  ) {
    return {
      conflict: true,
      reason: 'model-disabled',
    }
  }
  const conflict =
    !auxiliaryCompatibility.ok &&
    auxiliaryCompatibility.reason === 'reasoning-unsupported'
  return {
    conflict,
    reason: conflict ? 'reasoning-unsupported' : null,
  }
}

/** Serializes the provider form fields that identify a saved provider configuration. */
export function providerFormSignature(
  form: ProviderForm,
  models: Pick<
    UiModelProfile,
    | 'id'
    | 'contextWindowTokens'
    | 'compactThresholdTokens'
    | 'maxOutputTokens'
    | 'reasoningEfforts'
    | 'capability'
  >[] = [],
): string {
  return JSON.stringify({
    baseURL: form.baseURL,
    providerId: form.providerId,
    label: form.label,
    providerType: form.providerType,
    model: form.model,
    enabledModelIds: [...form.enabledModelIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    models: models
      .map((model) => ({
        id: model.id,
        contextWindowTokens: model.contextWindowTokens,
        compactThresholdTokens: model.compactThresholdTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEfforts: model.reasoningEfforts?.length
          ? normalizeReasoningEfforts(model.reasoningEfforts)
          : null,
        capability: model.capability ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}
