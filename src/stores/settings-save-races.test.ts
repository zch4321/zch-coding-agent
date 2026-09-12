// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { ConfigSetRequest, PublicConfig } from '../../shared/config'
import { useNetworkSettingsStore } from './network-settings'
import { useIntegrationSettingsStore } from './integration-settings'
import { useAssistantSettingsStore } from './assistant-settings'
import { useRuntimeSettingsStore } from './runtime-settings'
import { useProviderSettingsStore } from './agent-settings'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'

type Response = Awaited<ReturnType<AgentApi['setConfig']>>
function success(config: Partial<PublicConfig>): Response {
  return { version: 1, ok: true, value: { config: config as PublicConfig } }
}
function failed(message = 'Synthetic save failure'): Response {
  return { version: 1, ok: false, error: { code: 'INTERNAL_ERROR', message } }
}
function installQueue() {
  const calls: Array<{
    request: ConfigSetRequest
    resolve: (value: Response) => void
    reject: (error: Error) => void
  }> = []
  const setConfig = vi.fn(
    (request: ConfigSetRequest) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ request, resolve, reject })
      }),
  )
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: { setConfig } as Partial<AgentApi>,
  })
  return calls
}
const network = (url: string): PublicConfig['network'] => ({
  httpProxy: { mode: 'manual', url },
})
const webSearch = (
  count: number,
  credentialConfigured = true,
): PublicConfig['webSearch'] => ({
  provider: 'brave',
  count,
  credentialConfigured,
  credentialSource: credentialConfigured ? 'safe-storage' : 'none',
})

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  Reflect.deleteProperty(window, 'agentApi')
  vi.restoreAllMocks()
})

describe('settings save interleavings', () => {
  it.each(['success', 'failure', 'exception'] as const)(
    'preserves newer network input after an old %s response',
    async (outcome) => {
      const store = useNetworkSettingsStore()
      store.applyConfig({
        network: network('http://saved.example'),
      } as PublicConfig)
      store.networkConfig = network('http://old.example')
      const calls = installQueue()
      const saving = store.saveNetwork()
      store.networkConfig = network('http://new.example')
      await flushPromises()
      expect(calls[0]!.request).toMatchObject({
        kind: 'network',
        value: network('http://old.example'),
      })
      if (outcome === 'success')
        calls[0]!.resolve(success({ network: network('http://old.example') }))
      else if (outcome === 'failure') calls[0]!.resolve(failed())
      else calls[0]!.reject(new Error('Transport failed'))
      expect(await saving).toBe(outcome === 'success')
      expect(store.networkConfig).toEqual(network('http://new.example'))
      expect(store.networkDirty).toBe(true)
      expect(store.networkSaving).toBe(false)
      const retry = store.saveNetwork()
      await flushPromises()
      calls[1]!.resolve(success({ network: network('http://new.example') }))
      expect(await retry).toBe(true)
      expect(store.networkDirty).toBe(false)
    },
  )

  it('joins duplicate requests and honors another explicit save before the first IPC begins', async () => {
    const store = useNetworkSettingsStore()
    store.networkConfig = network('http://first.example')
    const calls = installQueue()
    const first = store.saveNetwork()
    store.networkConfig = network('http://second.example')
    const second = store.saveNetwork()
    await flushPromises()
    expect(calls).toHaveLength(1)
    calls[0]!.resolve(success({ network: network('http://first.example') }))
    await flushPromises()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.request).toMatchObject({
      value: network('http://second.example'),
    })
    const duplicate = store.saveNetwork()
    calls[1]!.resolve(success({ network: network('http://second.example') }))
    expect(await Promise.all([first, second, duplicate])).toEqual([
      true,
      true,
      true,
    ])
    expect(calls).toHaveLength(2)
  })

  it.each(['later', 'first'])(
    'saves a queued network snapshot while retaining the %s draft edited afterward',
    async (current) => {
      const store = useNetworkSettingsStore()
      const calls = installQueue()
      store.networkConfig = network('http://first.example')
      const first = store.saveNetwork()
      store.networkConfig = network('http://second.example')
      const second = store.saveNetwork()
      store.networkConfig = network(`http://${current}.example`)
      await flushPromises()
      calls[0]!.resolve(success({ network: network('http://first.example') }))
      await flushPromises()
      expect(calls[1]?.request).toMatchObject({
        kind: 'network',
        value: network('http://second.example'),
      })
      calls[1]!.resolve(success({ network: network('http://second.example') }))
      expect(await Promise.all([first, second])).toEqual([true, true])
      expect(calls).toHaveLength(2)
      expect(store.networkConfig).toEqual(network(`http://${current}.example`))
      expect(store.networkSavedSignature).toBe(
        JSON.stringify(network('http://second.example')),
      )
      expect(store.networkDirty).toBe(true)
    },
  )

  it('coalesces identical saves without submitting edits made after the repeated click', async () => {
    const store = useNetworkSettingsStore()
    const calls = installQueue()
    store.networkConfig = network('http://first.example')
    const first = store.saveNetwork()
    const duplicate = store.saveNetwork()
    store.networkConfig = network('http://unsaved.example')
    await flushPromises()
    calls[0]!.resolve(success({ network: network('http://first.example') }))
    expect(await Promise.all([first, duplicate])).toEqual([true, true])
    expect(calls).toHaveLength(1)
    expect(store.networkConfig).toEqual(network('http://unsaved.example'))
    expect(store.networkDirty).toBe(true)
  })

  it.each(['first', 'third'])(
    'coalesces queued saves to the last explicit %s snapshot',
    async (last) => {
      const store = useNetworkSettingsStore()
      const calls = installQueue()
      store.networkConfig = network('http://first.example')
      const first = store.saveNetwork()
      store.networkConfig = network('http://second.example')
      const second = store.saveNetwork()
      store.networkConfig = network(`http://${last}.example`)
      const third = store.saveNetwork()
      store.networkConfig = network('http://unsaved.example')
      await flushPromises()
      calls[0]!.resolve(success({ network: network('http://first.example') }))
      await flushPromises()
      if (last === 'third') {
        expect(calls[1]?.request).toMatchObject({
          value: network('http://third.example'),
        })
        calls[1]!.resolve(success({ network: network('http://third.example') }))
      }
      expect(await Promise.all([first, second, third])).toEqual([
        true,
        true,
        true,
      ])
      expect(calls).toHaveLength(last === 'first' ? 1 : 2)
      expect(store.networkConfig).toEqual(network('http://unsaved.example'))
      expect(store.networkDirty).toBe(true)
    },
  )

  it.each(['failure', 'exception'])(
    'retains newer input and permits retry after a queued save %s',
    async (outcome) => {
      const store = useNetworkSettingsStore()
      const calls = installQueue()
      store.networkConfig = network('http://first.example')
      const first = store.saveNetwork()
      store.networkConfig = network('http://second.example')
      const second = store.saveNetwork()
      store.networkConfig = network('http://unsaved.example')
      await flushPromises()
      calls[0]!.resolve(success({ network: network('http://first.example') }))
      await flushPromises()
      expect(calls[1]?.request).toMatchObject({
        value: network('http://second.example'),
      })
      if (outcome === 'failure') calls[1]!.resolve(failed())
      else calls[1]!.reject(new Error('Synthetic transport failure'))
      expect(await Promise.all([first, second])).toEqual([false, false])
      expect(store.networkConfig).toEqual(network('http://unsaved.example'))
      expect(store.networkDirty).toBe(true)
      expect(store.networkSaving).toBe(false)
      const retry = store.saveNetwork()
      await flushPromises()
      expect(calls[2]?.request).toMatchObject({
        value: network('http://unsaved.example'),
      })
      calls[2]!.resolve(success({ network: network('http://unsaved.example') }))
      expect(await retry).toBe(true)
      expect(store.networkDirty).toBe(false)
    },
  )

  it('captures count and key together without hydrating the credential response over them', async () => {
    const store = useIntegrationSettingsStore()
    store.applyConfig({ webSearch: webSearch(5, false) } as PublicConfig)
    store.webSearchForm.count = 12
    store.webSearchForm.apiKey = 'synthetic-key'
    const calls = installQueue()
    const saving = store.saveWebSearchSettings()
    const duplicate = store.saveWebSearchSettings()
    await flushPromises()
    expect(calls[0]!.request).toMatchObject({
      kind: 'web-search-credential',
      apiKey: 'synthetic-key',
    })
    calls[0]!.resolve(success({ webSearch: webSearch(5) }))
    await flushPromises()
    expect(store.webSearchForm.count).toBe(12)
    expect(calls[1]!.request).toMatchObject({ kind: 'web-search', count: 12 })
    calls[1]!.resolve(success({ webSearch: webSearch(12) }))
    expect(await Promise.all([saving, duplicate])).toEqual([true, true])
    expect(calls).toHaveLength(2)
    expect(store.webSearchForm).toEqual({
      provider: 'brave',
      count: 12,
      apiKey: '',
    })
    expect(store.webSearchDirty).toBe(false)
  })

  it('preserves a replacement key and count entered during both Web Search requests', async () => {
    const store = useIntegrationSettingsStore()
    store.webSearchForm = { provider: 'brave', count: 12, apiKey: 'first-key' }
    const calls = installQueue()
    const saving = store.saveWebSearchSettings()
    await flushPromises()
    store.webSearchForm.count = 14
    store.webSearchForm.apiKey = 'second-key'
    calls[0]!.resolve(success({ webSearch: webSearch(5) }))
    await flushPromises()
    expect(calls[1]!.request).toMatchObject({ count: 12 })
    calls[1]!.resolve(success({ webSearch: webSearch(12) }))
    expect(await saving).toBe(true)
    expect(store.webSearchForm).toEqual({
      provider: 'brave',
      count: 14,
      apiKey: 'second-key',
    })
    expect(store.webSearchSavedSignature).toBe('brave|12')
    expect(store.webSearchDirty).toBe(true)
  })

  it.each(['first-key', 'second-key'])(
    'uses queued Web Search snapshots and writes each committed key once (%s)',
    async (queuedKey) => {
      const store = useIntegrationSettingsStore()
      const calls = installQueue()
      store.webSearchForm = {
        provider: 'brave',
        count: 12,
        apiKey: 'first-key',
      }
      const first = store.saveWebSearchSettings()
      store.webSearchForm = { provider: 'brave', count: 14, apiKey: queuedKey }
      const second = store.saveWebSearchSettings()
      store.webSearchForm = {
        provider: 'brave',
        count: 16,
        apiKey: 'unsaved-key',
      }
      await flushPromises()
      calls[0]!.resolve(success({ webSearch: webSearch(5) }))
      await flushPromises()
      expect(calls[1]?.request).toMatchObject({ kind: 'web-search', count: 12 })
      calls[1]!.resolve(success({ webSearch: webSearch(12) }))
      await flushPromises()
      if (queuedKey === 'second-key') {
        expect(calls[2]?.request).toMatchObject({
          kind: 'web-search-credential',
          apiKey: queuedKey,
        })
        calls[2]!.resolve(success({ webSearch: webSearch(12) }))
        await flushPromises()
      }
      const last = calls.at(-1)!
      expect(last.request).toMatchObject({ kind: 'web-search', count: 14 })
      last.resolve(success({ webSearch: webSearch(14) }))
      expect(await Promise.all([first, second])).toEqual([true, true])
      expect(calls).toHaveLength(queuedKey === 'first-key' ? 3 : 4)
      expect(store.webSearchForm).toEqual({
        provider: 'brave',
        count: 16,
        apiKey: 'unsaved-key',
      })
      expect(store.webSearchDirty).toBe(true)
    },
  )

  it.each(['credential', 'config', 'exception'] as const)(
    'recovers a Web Search %s failure without losing drafts or resending a committed key',
    async (failure) => {
      const store = useIntegrationSettingsStore()
      store.webSearchForm = {
        provider: 'brave',
        count: 12,
        apiKey: 'synthetic-key',
      }
      const calls = installQueue()
      const saving = store.saveWebSearchSettings()
      await flushPromises()
      if (failure === 'credential') calls[0]!.resolve(failed())
      else {
        calls[0]!.resolve(success({ webSearch: webSearch(5) }))
        await flushPromises()
        if (failure === 'config') calls[1]!.resolve(failed())
        else calls[1]!.reject(new Error('Transport failed'))
      }
      expect(await saving).toBe(false)
      expect(store.webSearchForm.count).toBe(12)
      expect(store.webSearchForm.apiKey).toBe(
        failure === 'credential' ? 'synthetic-key' : '',
      )
      expect(store.webSearchCredentialConfigured).toBe(failure !== 'credential')
      expect(store.webSearchSavedSignature).toBe('brave|5')
      expect(store.webSearchDirty).toBe(true)
      expect(store.webSearchSaving).toBe(false)
    },
  )

  it('clears only credential state and excludes saves while that different command owns the lane', async () => {
    const store = useIntegrationSettingsStore()
    store.webSearchForm = { provider: 'brave', count: 12, apiKey: 'draft-key' }
    const calls = installQueue()
    const clearing = store.clearWebSearchCredential()
    expect(await store.saveWebSearchSettings()).toBe(false)
    await flushPromises()
    store.webSearchForm.count = 14
    calls[0]!.resolve(success({ webSearch: webSearch(5, false) }))
    expect(await clearing).toBe(true)
    expect(calls).toHaveLength(1)
    expect(store.webSearchForm).toEqual({
      provider: 'brave',
      count: 14,
      apiKey: 'draft-key',
    })
  })

  it('preserves assistant preferences edited while saving and serializes explicit language changes', async () => {
    const store = useAssistantSettingsStore()
    store.assistantForm.preferences['zh-CN'] = 'first draft'
    const calls = installQueue()
    const saving = store.saveAssistantSettings('en-US')
    await flushPromises()
    store.assistantForm.preferences['zh-CN'] = 'new draft'
    const first = calls[0]!.request
    if (first.kind !== 'assistant')
      throw new Error('Expected assistant request')
    calls[0]!.resolve(success({ assistant: first.value }))
    expect(await saving).toBe(true)
    expect(store.assistantForm.preferences['zh-CN']).toBe('new draft')
    expect(store.assistantSaveStatus).toBe('')
    const second = store.saveAssistantSettings('zh-CN')
    const third = store.saveAssistantSettings('en-US')
    await flushPromises()
    const request = calls[1]!.request
    if (request.kind !== 'assistant')
      throw new Error('Expected assistant request')
    calls[1]!.resolve(success({ assistant: request.value }))
    await flushPromises()
    const last = calls[2]!.request
    expect(last).toMatchObject({
      kind: 'assistant',
      value: { language: 'en-US' },
    })
    if (last.kind !== 'assistant') throw new Error('Expected assistant request')
    calls[2]!.resolve(success({ assistant: last.value }))
    expect(await Promise.all([second, third])).toEqual([true, true])
    expect(store.assistantForm.language).toBe('en-US')
  })

  it('drains Runtime edits through an in-flight save when the settings page flushes', async () => {
    const store = useRuntimeSettingsStore()
    const config = toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
    config.limits.maxStepsPerRun = 10
    config.limits.maxContextTokens = 600_000
    store.applyConfig(config, ['limits'])
    const calls = installQueue()
    const saving = store.saveLimits()
    await flushPromises()
    store.limitsConfig!.maxStepsPerRun = 20
    store.limitsConfig!.maxContextTokens = 900_000
    const flushing = store.saveLimits()
    calls[0]!.resolve(success(config))
    await flushPromises()
    expect(calls[1]!.request).toMatchObject({
      kind: 'limits',
      value: { maxStepsPerRun: 20 },
    })
    expect(
      useProviderSettingsStore().providerTokenDefaults().maxContextTokens,
    ).toBe(600_000)
    expect(store.limitsConfig!.maxContextTokens).toBe(900_000)
    expect(store.limitsDirty).toBe(true)
    calls[1]!.resolve(
      success({
        ...config,
        limits: {
          ...config.limits,
          maxStepsPerRun: 20,
          maxContextTokens: 900_000,
        },
      }),
    )
    expect(await Promise.all([saving, flushing])).toEqual([true, true])
    expect(store.limitsDirty).toBe(false)
    expect(store.limitsSaving).toBe(false)
    expect(
      useProviderSettingsStore().providerTokenDefaults().maxContextTokens,
    ).toBe(900_000)
  })

  it('captures each queued language change without persisting preferences edited afterward', async () => {
    const store = useAssistantSettingsStore()
    const calls = installQueue()
    store.assistantForm.preferences['zh-CN'] = 'first draft'
    const first = store.saveAssistantSettings('en-US')
    store.assistantForm.preferences['zh-CN'] = 'second draft'
    const second = store.saveAssistantSettings('zh-CN')
    store.assistantForm.preferences['zh-CN'] = 'unsaved draft'
    await flushPromises()
    const firstRequest = calls[0]!.request
    if (firstRequest.kind !== 'assistant') throw new Error('Expected assistant')
    calls[0]!.resolve(success({ assistant: firstRequest.value }))
    await flushPromises()
    const secondRequest = calls[1]!.request
    expect(secondRequest).toMatchObject({
      kind: 'assistant',
      value: { language: 'zh-CN', preferences: { 'zh-CN': 'second draft' } },
    })
    if (secondRequest.kind !== 'assistant')
      throw new Error('Expected assistant')
    calls[1]!.resolve(success({ assistant: secondRequest.value }))
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(store.assistantForm.preferences['zh-CN']).toBe('unsaved draft')
    expect(store.assistantForm.language).toBe('zh-CN')
    expect(store.assistantSaveStatus).toBe('')
  })

  it('rolls a failed queued language change back to the last successful write while retaining preferences', async () => {
    const store = useAssistantSettingsStore()
    const calls = installQueue()
    const first = store.saveAssistantSettings('en-US')
    const queued = store.saveAssistantSettings('zh-CN')
    await flushPromises()
    const request = calls[0]!.request
    if (request.kind !== 'assistant')
      throw new Error('Expected assistant request')
    calls[0]!.resolve(success({ assistant: request.value }))
    await flushPromises()
    store.assistantForm.preferences['zh-CN'] = 'retained draft'
    calls[1]!.resolve(failed())
    expect(await Promise.all([first, queued])).toEqual([false, false])
    expect(store.assistantForm.language).toBe('en-US')
    expect(store.assistantForm.preferences['zh-CN']).toBe('retained draft')
    expect(store.assistantSaving).toBe(false)
  })
})
