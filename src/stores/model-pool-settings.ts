import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import {
  type ConfigSection,
  type ModelPoolConfig,
  type ModelPoolEntry,
  type ProviderPublicConfig,
  type PublicConfig,
  type ReasoningEffort,
} from '../../shared/config'
import { evaluateModelRouteCompatibility } from '../../shared/model-route'

const modelPoolSaveOperations = new WeakMap<object, Promise<boolean>>()

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function modelPoolSignature(modelPool: ModelPoolConfig): string {
  return JSON.stringify(modelPool)
}

function nextEntryId(entries: readonly ModelPoolEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id.trim()))
  let index = 1
  while (existing.has(`worker-${index}`)) index += 1
  return `worker-${index}`
}

/** Identifies one exact model-pool route exposed by the renderer catalog. */
export interface ModelPoolSelectableRoute {
  providerId: string
  model: string
  reasoning: ReasoningEffort
}

/** Encodes one exact Provider, model, and reasoning route for renderer selection. */
export function modelPoolRouteKey(route: ModelPoolSelectableRoute): string {
  return JSON.stringify([route.providerId, route.model, route.reasoning])
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
    /** Replaces the pool membership with exact routes selected by the transfer UI. */
    setSelectedRoutes(
      selectedKeys: readonly string[],
      routes: readonly ModelPoolSelectableRoute[],
    ) {
      const routesByKey = new Map(
        routes.map((route) => [modelPoolRouteKey(route), route]),
      )
      const existingByKey = new Map<string, ModelPoolEntry>()
      for (const entry of this.entries) {
        const key = modelPoolRouteKey(entry)
        if (!existingByKey.has(key)) existingByKey.set(key, entry)
      }

      const nextEntries: ModelPoolEntry[] = []
      const selected = new Set<string>()
      for (const key of selectedKeys) {
        if (selected.has(key)) continue
        selected.add(key)
        const existing = existingByKey.get(key)
        if (existing) {
          nextEntries.push({ ...existing })
          continue
        }
        const route = routesByKey.get(key)
        if (!route) continue
        nextEntries.push({
          id: nextEntryId([...this.entries, ...nextEntries]),
          enabled: true,
          providerId: route.providerId,
          model: route.model,
          reasoning: route.reasoning,
          maxParallel: 1,
        })
      }
      this.entries = nextEntries
      this.saveStatus = ''
    },
    /** Updates concurrency metadata for every entry sharing one exact route. */
    setMaxParallel(routeKey: string, value: number) {
      if (!Number.isInteger(value) || value < 1 || value > 32) return
      for (const entry of this.entries) {
        if (modelPoolRouteKey(entry) === routeKey) entry.maxParallel = value
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
