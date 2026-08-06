import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import {
  REASONING_EFFORTS,
  type ConfigSection,
  type ModelPoolConfig,
  type ModelPoolEntry,
  type ProviderPublicConfig,
  type PublicConfig,
  type ReasoningEffort,
} from '../../shared/config'
import { evaluateModelRouteCompatibility } from '../../shared/model-route'
import { resolveSupportedReasoningEfforts } from '../../shared/model-settings'

const modelPoolSaveOperations = new WeakMap<object, Promise<boolean>>()

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function modelPoolSignature(modelPool: ModelPoolConfig): string {
  return JSON.stringify(modelPool)
}

function annotatedModelIds(provider: ProviderPublicConfig): string[] {
  return provider.enabledModelIds.filter(
    (model) => provider.modelOverrides[model]?.capability,
  )
}

function defaultReasoning(
  provider: ProviderPublicConfig,
  model: string,
  preferred?: ReasoningEffort,
): ReasoningEffort {
  const supported = resolveSupportedReasoningEfforts(
    provider.modelOverrides[model],
  )
  return (
    (preferred && supported.includes(preferred) ? preferred : undefined) ??
    (supported.includes(provider.reasoning) ? provider.reasoning : undefined) ??
    supported[0] ??
    REASONING_EFFORTS[0]
  )
}

function nextEntryId(entries: readonly ModelPoolEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id.trim()))
  let index = 1
  while (existing.has(`worker-${index}`)) index += 1
  return `worker-${index}`
}

function providerForEntry(
  providers: readonly ProviderPublicConfig[],
  entry: ModelPoolEntry,
): ProviderPublicConfig | undefined {
  return providers.find((provider) => provider.id === entry.providerId)
}

function enabledEntryError(
  entries: readonly ModelPoolEntry[],
  providers: readonly ProviderPublicConfig[],
): string | undefined {
  for (const entry of entries) {
    if (!entry.enabled) continue
    const provider = providerForEntry(providers, entry)
    if (!provider) return `Provider is not configured: ${entry.providerId}`
    const compatibility = evaluateModelRouteCompatibility(provider, entry)
    if (!compatibility.ok) {
      return `Model pool entry ${entry.id} has an invalid model route`
    }
    if (!provider.modelOverrides[entry.model]?.capability) {
      return `Model ${entry.model} must have a capability annotation before it can be enabled in the model pool`
    }
    if (!provider.credentialConfigured) {
      return `${provider.label} credential is not configured`
    }
  }
  return undefined
}

export const useModelPoolSettingsStore = defineStore('model-pool-settings', {
  state: () => ({
    error: '',
    entries: [] as ModelPoolEntry[],
    savedSignature: modelPoolSignature({ entries: [] }),
    saving: false,
    saveStatus: '',
  }),
  getters: {
    dirty: (state) =>
      modelPoolSignature({ entries: state.entries }) !== state.savedSignature,
  },
  actions: {
    /** Hydrates the model-pool draft from an explicit configuration snapshot. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('modelPool')) return
      this.entries = structuredClone(config.modelPool.entries)
      this.savedSignature = modelPoolSignature(config.modelPool)
      this.saveStatus = ''
    },
    /** Reconciles Provider-triggered pool repairs without discarding a dirty draft. */
    applyExternalConfig(config: PublicConfig) {
      const externalSignature = modelPoolSignature(config.modelPool)
      if (externalSignature === this.savedSignature) return
      const wasDirty = this.dirty
      this.savedSignature = externalSignature
      if (wasDirty) {
        this.saveStatus = 'external-change'
        return
      }
      this.entries = structuredClone(config.modelPool.entries)
      this.saveStatus = ''
    },
    /** Adds one disabled entry using the first Provider model with a capability annotation. */
    addEntry(providers: readonly ProviderPublicConfig[]) {
      const provider = providers.find(
        (candidate) => annotatedModelIds(candidate).length > 0,
      )
      if (!provider) return false
      const model = annotatedModelIds(provider)[0]!
      this.entries.push({
        id: nextEntryId(this.entries),
        enabled: false,
        providerId: provider.id,
        model,
        reasoning: defaultReasoning(provider, model),
        maxParallel: 1,
      })
      this.saveStatus = ''
      return true
    },
    /** Removes one model-pool entry from the draft. */
    removeEntry(index: number) {
      if (index < 0 || index >= this.entries.length) return
      this.entries.splice(index, 1)
      this.saveStatus = ''
    },
    /** Moves one entry by one position while preserving declaration order. */
    moveEntry(index: number, direction: -1 | 1) {
      const target = index + direction
      if (index < 0 || index >= this.entries.length) return
      if (target < 0 || target >= this.entries.length) return
      const [entry] = this.entries.splice(index, 1)
      this.entries.splice(target, 0, entry!)
      this.saveStatus = ''
    },
    /** Selects a Provider and initializes the dependent model and reasoning fields. */
    selectProvider(
      index: number,
      providerId: string,
      providers: readonly ProviderPublicConfig[],
    ) {
      const entry = this.entries[index]
      const provider = providers.find(
        (candidate) => candidate.id === providerId,
      )
      if (!entry || !provider) return
      const model = annotatedModelIds(provider)[0] ?? ''
      entry.providerId = provider.id
      entry.model = model
      if (model) {
        entry.reasoning = defaultReasoning(provider, model, entry.reasoning)
      }
      this.saveStatus = ''
    },
    /** Selects a model and keeps the current reasoning when the model supports it. */
    selectModel(
      index: number,
      model: string,
      providers: readonly ProviderPublicConfig[],
    ) {
      const entry = this.entries[index]
      if (!entry) return
      const provider = providerForEntry(providers, entry)
      entry.model = model
      if (provider) {
        entry.reasoning = defaultReasoning(provider, model, entry.reasoning)
      }
      this.saveStatus = ''
    },
    /** Persists the complete pool with exact revisions for every enabled Provider. */
    async save(providers: readonly ProviderPublicConfig[]): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge) return false

      const activeOperation = modelPoolSaveOperations.get(this)
      if (activeOperation) {
        const saved = await activeOperation
        return saved && this.dirty ? this.save(providers) : saved
      }

      const operation = (async (): Promise<boolean> => {
        this.error = ''
        this.saveStatus = ''
        this.saving = true
        try {
          while (this.dirty) {
            const entries = cloneJson(this.entries)
            const validationError = enabledEntryError(entries, providers)
            if (validationError) {
              this.error = validationError
              this.saveStatus = validationError
              return false
            }

            const revisions: Array<{
              providerId: string
              revision: number
            }> = []
            const covered = new Set<string>()
            for (const entry of entries) {
              if (!entry.enabled || covered.has(entry.providerId)) continue
              const provider = providerForEntry(providers, entry)!
              covered.add(provider.id)
              revisions.push({
                providerId: provider.id,
                revision: provider.revision,
              })
            }

            const draftSignature = modelPoolSignature({ entries })
            const result = await bridge.setConfig({
              version: IPC_VERSION,
              kind: 'model-pool',
              value: { entries },
              expectedProviderRevisions: revisions,
            })
            if (!result.ok) {
              this.error = result.error.message
              this.saveStatus = result.error.message
              return false
            }

            this.savedSignature = draftSignature
            if (
              modelPoolSignature({ entries: this.entries }) !== draftSignature
            ) {
              continue
            }
            this.applyConfig(result.value.config, ['modelPool'])
            this.saveStatus = 'saved'
            return true
          }
          return true
        } finally {
          this.saving = false
        }
      })()
      const trackedOperation = operation.finally(() => {
        modelPoolSaveOperations.delete(this)
      })
      modelPoolSaveOperations.set(this, trackedOperation)
      return trackedOperation
    },
  },
})
