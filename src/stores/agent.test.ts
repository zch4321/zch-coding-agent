// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from './agent'
import { useApprovalSettingsStore } from './approval-settings'
import { useAgentRuntimeStore } from './agent-runtime'
import { useAgentSettingsStore } from './agent-settings'

/** Members the facade deliberately does not route, grouped by reason. */
const INTERNAL_MEMBERS = new Set([
  // Hidden by the AgentFacade type itself.
  'draftModelSelection',
  'error',
  'limitsSavedSignature',
  'subagentsSavedSignature',
  'applyConfig',
  'selectProvider',
  // Settings actions only invoked internally or via direct store injection.
  'loadSelectedProviderModelsOnEntry',
  'saveWebSearchSettings',
  'clearWebSearchCredential',
  // Web search settings are consumed through direct settings-store injection
  // (WebSearchSettingsPanel), never through the facade.
  'webSearchCredentialConfigured',
  'webSearchDirty',
  'webSearchForm',
  'webSearchSaveStatus',
  'webSearchSavedSignature',
  'webSearchSaving',
  // Runtime internal bookkeeping and action-only plumbing.
  'startPendingSessionId',
  'carryoversBySessionId',
  'carryoverStartingBySessionId',
  'activeOverlay',
  'ensureOverlay',
  'hydrateRuntime',
  'updateModelSelection',
  'applyRunStartResult',
  'flushCarryovers',
])

function missingFacadeRoutes(store: object): string[] {
  const facade = useAgentStore()
  const missing: string[] = []
  for (const key of Object.keys(store)) {
    // Skip Pinia internals ($*) and test-harness artifacts (_*).
    if (key.startsWith('$') || key.startsWith('_')) continue
    if (INTERNAL_MEMBERS.has(key)) continue
    if (!(key in facade)) missing.push(key)
  }
  return missing.sort()
}

describe('agent facade contract', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('exposes every facade-consumed settings action through the facade', () => {
    const facade = useAgentStore()
    const settings = useAgentSettingsStore()
    const missing: string[] = []
    for (const key of Object.keys(settings)) {
      if (key.startsWith('$') || key.startsWith('_')) continue
      if (INTERNAL_MEMBERS.has(key)) continue
      const value = Reflect.get(settings, key) as unknown
      if (typeof value !== 'function') continue
      if (typeof Reflect.get(facade, key) !== 'function') {
        missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })

  it('routes every facade-consumed runtime member through the facade', () => {
    expect(missingFacadeRoutes(useAgentRuntimeStore())).toEqual([])
  })

  it('routes every facade-consumed approval member through the facade', () => {
    expect(missingFacadeRoutes(useApprovalSettingsStore())).toEqual([])
  })

  it('routes every facade-consumed settings member through the facade', () => {
    expect(missingFacadeRoutes(useAgentSettingsStore())).toEqual([])
  })

  it('exposes the per-model annotation mutation used by provider settings', () => {
    const facade = useAgentStore()
    expect(typeof facade.updateModelAnnotation).toBe('function')
  })

  it('exposes the composer reasoning validity getter used by the composer', () => {
    const facade = useAgentStore()
    expect('composerReasoningValid' in facade).toBe(true)
  })
})
