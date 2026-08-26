import { describe, expect, it } from 'vitest'
import {
  AGENT_API_INVOKE_ROUTES,
  AGENT_API_KEYS,
  AGENT_API_SUBSCRIPTION_ROUTES,
  createAgentApi,
  type AgentApiSubscriptionAdapters,
  type IpcInvoke,
} from './agent-api'
import { IPC_CONTRACTS, type IpcChannel } from './ipc/registry'

function createSubscriptionAdapters(): AgentApiSubscriptionAdapters {
  return {
    agentEvent: () => () => undefined,
    agentExecutionEvent: () => () => undefined,
    backendNotification: () => () => undefined,
    terminalEvent: () => () => undefined,
    domainState: () => () => undefined,
  }
}

describe('Agent API manifest', () => {
  it('derives the fixed public key order from invoke and subscription routes', () => {
    const invokeMethods = Object.keys(AGENT_API_INVOKE_ROUTES)
    const subscriptionMethods = Object.keys(AGENT_API_SUBSCRIPTION_ROUTES)

    expect(Object.values(AGENT_API_INVOKE_ROUTES)).toEqual(
      Object.keys(IPC_CONTRACTS),
    )
    expect(invokeMethods).toHaveLength(72)
    expect(subscriptionMethods).toHaveLength(5)
    expect(AGENT_API_KEYS).toEqual([...invokeMethods, ...subscriptionMethods])
    expect(new Set(AGENT_API_KEYS).size).toBe(AGENT_API_KEYS.length)
    expect(AGENT_API_KEYS).not.toContain('invoke')
    expect(Object.isFrozen(AGENT_API_INVOKE_ROUTES)).toBe(true)
    expect(Object.isFrozen(AGENT_API_SUBSCRIPTION_ROUTES)).toBe(true)
    expect(Object.isFrozen(AGENT_API_KEYS)).toBe(true)
  })

  it('binds every generated invoke method to its declared channel', async () => {
    const calls: Array<{ channel: IpcChannel; payload: unknown }> = []
    const failure = {
      version: 1,
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'test fixture' },
    } as const
    const invoke = (async (channel: IpcChannel, payload: unknown) => {
      calls.push({ channel, payload })
      return failure
    }) as unknown as IpcInvoke
    const api = createAgentApi(invoke, createSubscriptionAdapters())
    const apiRecord = api as unknown as Record<
      string,
      (payload: unknown) => Promise<unknown>
    >

    for (const [method, channel] of Object.entries(AGENT_API_INVOKE_ROUTES)) {
      const payload = { method }
      await expect(apiRecord[method]!(payload)).resolves.toBe(failure)
      expect(calls.at(-1)).toEqual({ channel, payload })
    }

    expect(calls).toHaveLength(Object.keys(AGENT_API_INVOKE_ROUTES).length)
  })

  it('binds public subscription methods to the explicit preload adapters', () => {
    const adapters = createSubscriptionAdapters()
    const api = createAgentApi(
      (async () => undefined) as unknown as IpcInvoke,
      adapters,
    )
    const apiRecord = api as unknown as Record<string, unknown>
    const adapterRecord = adapters as unknown as Record<string, unknown>

    for (const [method, adapter] of Object.entries(
      AGENT_API_SUBSCRIPTION_ROUTES,
    )) {
      expect(apiRecord[method]).toBe(adapterRecord[adapter])
    }
    expect(Object.keys(api)).toEqual(AGENT_API_KEYS)
  })
})
