import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'

export function setupAgentTest(): void {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })
}

export function installApi(api: Partial<AgentApi>) {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
}
