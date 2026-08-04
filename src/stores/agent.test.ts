// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from './agent'
import { useAgentSettingsStore } from './agent-settings'

describe('agent facade contract', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('exposes every facade-consumed settings action through the facade', () => {
    // Actions intentionally absent from the facade action map:
    // - loadSelectedProviderModelsOnEntry is only invoked internally by
    //   enterProviderSettings.
    // - Web search actions are consumed through direct settings-store
    //   injection (WebSearchSettingsPanel), never through the facade.
    const internalActions = new Set([
      'loadSelectedProviderModelsOnEntry',
      'saveWebSearchSettings',
      'clearWebSearchCredential',
    ])
    const facade = useAgentStore()
    const settings = useAgentSettingsStore()
    const missing: string[] = []
    for (const key of Object.keys(settings)) {
      // Skip Pinia internals ($*) and test-harness artifacts (_*).
      if (key.startsWith('$') || key.startsWith('_')) continue
      if (internalActions.has(key)) continue
      const value = Reflect.get(settings, key) as unknown
      if (typeof value !== 'function') continue
      if (typeof Reflect.get(facade, key) !== 'function') {
        missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })

  it('exposes the per-model annotation mutation used by provider settings', () => {
    const facade = useAgentStore()
    expect(typeof facade.updateModelAnnotation).toBe('function')
  })
})
