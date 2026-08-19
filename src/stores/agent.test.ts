// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from './agent'
import { useApplicationSettingsStore } from './application-settings'
import { useAssistantSettingsStore } from './assistant-settings'
import { useModelRolesStore } from './model-roles'
import { useAgentRuntimeStore } from './agent-runtime'
import { useProviderSettingsStore } from './agent-settings'
import { useNetworkSettingsStore } from './network-settings'
import { useRuntimeSettingsStore } from './runtime-settings'
import { useSecuritySettingsStore } from './security-settings'

/** Members the facade deliberately does not route, grouped by reason. */
const INTERNAL_MEMBERS = new Set([
  // Hidden by the AgentFacade type itself.
  'draftModelSelection',
  'error',
  'limitsSavedSignature',
  'subagentsSavedSignature',
  'networkSavedSignature',
  'permissionSavedSignature',
  'providerSavedSignature',
  'applyConfig',
  'persistRoles',
  // Settings actions only invoked internally or via direct store injection.
  'acceptNotice',
  'acceptTraceNotice',
  'loadSelectedProviderModelsOnEntry',
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
    const missing: string[] = []
    const settingsStores = [
      useApplicationSettingsStore(),
      useAssistantSettingsStore(),
      useNetworkSettingsStore(),
      useProviderSettingsStore(),
      useRuntimeSettingsStore(),
      useSecuritySettingsStore(),
    ]
    for (const settings of settingsStores) {
      for (const key of Object.keys(settings)) {
        if (key.startsWith('$') || key.startsWith('_')) continue
        if (INTERNAL_MEMBERS.has(key)) continue
        const value = Reflect.get(settings, key) as unknown
        if (typeof value !== 'function') continue
        if (typeof Reflect.get(facade, key) !== 'function') {
          missing.push(key)
        }
      }
    }
    expect(missing.sort()).toEqual([])
  })

  it('routes every facade-consumed runtime member through the facade', () => {
    expect(missingFacadeRoutes(useAgentRuntimeStore())).toEqual([])
  })

  it('routes every facade-consumed model-roles member through the facade', () => {
    expect(missingFacadeRoutes(useModelRolesStore())).toEqual([])
  })

  it('routes every facade-consumed settings member through the facade', () => {
    expect(missingFacadeRoutes(useApplicationSettingsStore())).toEqual([])
    expect(missingFacadeRoutes(useAssistantSettingsStore())).toEqual([])
    expect(missingFacadeRoutes(useNetworkSettingsStore())).toEqual([])
    expect(missingFacadeRoutes(useProviderSettingsStore())).toEqual([])
    expect(missingFacadeRoutes(useRuntimeSettingsStore())).toEqual([])
    expect(missingFacadeRoutes(useSecuritySettingsStore())).toEqual([])
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
