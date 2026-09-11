// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { useAgentStore, type AgentFacade } from './agent'
import { useAgentRuntimeStore } from './agent-runtime'
import { useProviderSettingsStore } from './agent-settings'
import { useNetworkSettingsStore } from './network-settings'
import { combineStoreMembers, pickStoreMembers } from './store-facade'

beforeEach(() => setActivePinia(createPinia()))

describe('agent facade contract', () => {
  it('rejects internal store capabilities both in types and at runtime', () => {
    expectTypeOf<AgentFacade>().not.toHaveProperty('ensureOverlay')
    expectTypeOf<AgentFacade>().not.toHaveProperty('hydrateRuntime')
    expectTypeOf<AgentFacade>().not.toHaveProperty('$patch')
    expectTypeOf<AgentFacade>().not.toHaveProperty('providerSavedSignature')
    const facade = useAgentStore()
    for (const key of [
      'ensureOverlay',
      'hydrateRuntime',
      '$patch',
      'providerSavedSignature',
    ]) {
      expect(key in facade).toBe(false)
      expect(Reflect.get(facade, key)).toBeUndefined()
    }
    expect('projects' in facade).toBe(true)
    expect('workspacePath' in facade).toBe(true)
  })

  it('keeps reactive reads and writes connected to the owning store', () => {
    const facade = useAgentStore()
    const network = useNetworkSettingsStore()
    const saving = computed(() => facade.networkSaving)
    expect(saving.value).toBe(false)
    network.networkSaving = true
    expect(saving.value).toBe(true)
    facade.networkSaving = false
    expect(network.networkSaving).toBe(false)
  })

  it('preserves bound actions and the separate provider draft action', () => {
    const facade = useAgentStore()
    const runtime = useAgentRuntimeStore()
    const providers = useProviderSettingsStore()
    expect(facade.newConversation).toBe(runtime.newConversation)
    expect(facade.setProviderModel).toBe(runtime.setProviderModel)
    expect(facade.setProviderDraftModel).toBe(providers.setProviderModel)
    expect(facade.updateModelAnnotation).toBe(providers.updateModelAnnotation)
    expect(facade.saveNetwork).toBe(useNetworkSettingsStore().saveNetwork)
  })

  it('derives the picked type from its runtime keys without evaluating getters during assembly', () => {
    let reads = 0
    const store = {
      value: 1,
      privateValue: 2,
      get doubled() {
        reads++
        return this.value * 2
      },
    }
    const picked = pickStoreMembers(store, ['value', 'doubled'])
    const facade = combineStoreMembers(picked, { action: () => 'done' })
    expect(reads).toBe(0)
    expect(Object.keys(facade)).toEqual(['value', 'doubled', 'action'])
    expectTypeOf(facade).not.toHaveProperty('privateValue')
    store.value = 3
    expect(facade.doubled).toBe(6)
    expect(facade.action()).toBe('done')
    expect(() => combineStoreMembers(picked, { value: 9 })).toThrow(
      'Duplicate facade capability: value',
    )
  })
})
