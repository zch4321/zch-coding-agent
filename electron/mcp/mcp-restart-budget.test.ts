import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../shared/mcp'
import type { ConfigStore } from '../config/store'
import type { McpStdioConnectionOptions } from './mcp-stdio-connection'
import { McpManager, launchFingerprint } from './mcp-manager'

const connections = vi.hoisted(
  () => [] as Array<{ options: McpStdioConnectionOptions }>,
)
vi.mock('./mcp-stdio-connection', () => ({
  McpStdioConnection: class {
    constructor(readonly options: McpStdioConnectionOptions) {
      connections.push(this)
    }
    async connect() {
      return { tools: [] }
    }
    async close() {
      this.options.onClosed?.()
    }
  },
}))

let manager: McpManager
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  connections.length = 0
  const config: McpServerConfig = {
    id: 'fixture',
    label: 'Fixture',
    description: '',
    enabled: true,
    scope: 'global',
    transport: 'stdio',
    command: 'unused',
    args: [],
    startupTimeoutMs: 100,
    toolTimeoutMs: 100,
  }
  config.launchTrust = {
    fingerprint: launchFingerprint(config),
    trustedAt: new Date().toISOString(),
  }
  manager = new McpManager({
    defaultCwd: process.cwd(),
    configStore: {
      getMcpServers: () => [structuredClone(config)],
      reloadFromDisk: async () => undefined,
      setMcpServerEnabled: async (_id: string, enabled: boolean) => {
        config.enabled = enabled
      },
    } as unknown as ConfigStore,
  })
  await manager.initialize()
  await vi.advanceTimersByTimeAsync(0)
})
afterEach(async () => {
  await manager.dispose()
  vi.useRealTimers()
})

describe('MCP restart budget', () => {
  it('backs off rapid exits and cannot bypass exhaustion or backoff through catalog/reload', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      connections.at(-1)!.options.onClosed?.()
      expect(manager.listStatuses()[0]?.state).toBe('restarting')
      await expect(manager.catalog('fixture', process.cwd())).rejects.toThrow(
        'unavailable',
      )
      await manager.reload()
      await vi.advanceTimersByTimeAsync(500 * 2 ** attempt - 1)
      expect(connections).toHaveLength(attempt + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(manager.listStatuses()[0]?.state).toBe('ready')
    }
    connections.at(-1)!.options.onClosed?.()
    expect(manager.listStatuses()[0]?.state).toBe('error')
    await manager.reload()
    await expect(manager.catalog('fixture', process.cwd())).rejects.toThrow(
      'exited repeatedly',
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connections).toHaveLength(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets after a stable minute and on manual restart, ignoring stale close callbacks', async () => {
    connections.at(-1)!.options.onClosed?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(60_000)
    connections.at(-1)!.options.onClosed?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(connections).toHaveLength(3)
    const previous = connections.at(-1)!
    await manager.restart('fixture')
    previous.options.onClosed?.()
    expect(manager.listStatuses()[0]?.state).toBe('ready')
    connections.at(-1)!.options.onClosed?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(connections).toHaveLength(5)
  })

  it.each(['disable', 'dispose'] as const)(
    'clears pending restarts on %s',
    async (action) => {
      connections.at(-1)!.options.onClosed?.()
      if (action === 'disable') await manager.disable('fixture')
      else await manager.dispose()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(connections).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
