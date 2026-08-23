// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { PublicConfig } from '../../shared/config/public-config'
import { useApplicationSettingsStore } from './application-settings'

const logging = {
  operational: {
    level: 'warn' as const,
    retentionDays: 7,
    maxTotalBytes: 25_000_000,
  },
  trace: {
    enabled: false,
    retentionDays: 30,
    maxTotalBytes: 750_000_000,
  },
}

function config(): PublicConfig {
  return { logging } as unknown as PublicConfig
}

function installApi(api: Partial<AgentApi>) {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
}

describe('application logging settings', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => Reflect.deleteProperty(window, 'agentApi'))

  it('hydrates and saves operational and Trace budgets independently', async () => {
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config: config(), warnings: [] },
    }))
    const getRuntimeLogStatus = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        enabled: true,
        level: 'warn' as const,
        degraded: false,
      },
    }))
    installApi({ setConfig, getRuntimeLogStatus })
    const store = useApplicationSettingsStore()
    store.applyConfig(config())

    expect(store.loggingForm).toEqual({
      operational: {
        level: 'warn',
        retentionDays: 7,
        maxTotalMegabytes: 25,
      },
      trace: {
        enabled: false,
        retentionDays: 30,
        maxTotalMegabytes: 750,
      },
    })
    await store.saveLogging()
    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'logging',
      value: logging,
    })
    expect(getRuntimeLogStatus).toHaveBeenCalledOnce()
  })

  it('opens and clears only the operational history through dedicated IPC', async () => {
    const openRuntimeLogDirectory = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true },
    }))
    const clearRuntimeLogs = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { deleted: 3, deletedBytes: 30 },
    }))
    const getRuntimeLogStatus = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        enabled: false,
        level: 'off' as const,
        degraded: true,
        warning: 'disk unavailable',
      },
    }))
    installApi({
      openRuntimeLogDirectory,
      clearRuntimeLogs,
      getRuntimeLogStatus,
    })
    const store = useApplicationSettingsStore()

    await store.openRuntimeLogDirectory()
    await store.clearRuntimeLogs()
    expect(openRuntimeLogDirectory).toHaveBeenCalledWith({ version: 1 })
    expect(clearRuntimeLogs).toHaveBeenCalledWith({ version: 1 })
    expect(store.runtimeLogActionMessage).toBe('3')
    expect(store.runtimeLogStatus).toMatchObject({
      level: 'off',
      degraded: true,
    })
  })
})
