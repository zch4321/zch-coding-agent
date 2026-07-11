import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../shared/mcp'
import type { ConfigStore } from '../config/store'
import { launchFingerprint, McpManager } from './mcp-manager'

const fixture = path.resolve('electron/mcp/fixtures/fake-mcp-server.mjs')
const managers: McpManager[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  )
  delete process.env.ZCH_MCP_TEST_SECRET
})

function trustedConfig(
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  const config: McpServerConfig = {
    id: 'fixture',
    label: 'Fixture',
    description: 'Deterministic test server',
    enabled: true,
    scope: 'global',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    envFromHost: { FAKE_SECRET: 'ZCH_MCP_TEST_SECRET' },
    startupTimeoutMs: 5_000,
    toolTimeoutMs: 5_000,
    ...overrides,
  }
  config.launchTrust = {
    fingerprint: launchFingerprint(config),
    trustedAt: new Date().toISOString(),
  }
  return config
}

function configStore(configs: McpServerConfig[]): ConfigStore {
  return {
    getMcpServers: () => structuredClone(configs),
  } as unknown as ConfigStore
}

async function createManager(
  config: McpServerConfig,
  waitUntilReady = true,
): Promise<McpManager> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-mcp-manager-'))
  directories.push(directory)
  const manager = new McpManager({
    configStore: configStore([config]),
    defaultCwd: directory,
  })
  managers.push(manager)
  await manager.initialize()
  if (waitUntilReady) {
    await waitFor(() => manager.listStatuses()[0]?.state === 'ready')
  }
  return manager
}

describe('McpManager', () => {
  it('discovers every tools/list page, redacts host secrets and calls tools', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(trustedConfig())
    const status = manager.listStatuses()[0]

    expect(status).toMatchObject({ state: 'ready', toolCount: 2 })
    expect(status.stderrTail).toContain('[redacted]')
    expect(status.stderrTail).not.toContain('test-secret-value')

    const catalog = await manager.catalog('fixture', process.cwd())
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta'])
    const result = await manager.callTool({
      serverId: 'fixture',
      workspace: process.cwd(),
      toolName: 'alpha',
      arguments: { value: 'hello' },
      expectedRevision: catalog.revision,
    })
    expect(result.structuredContent).toEqual({ echoed: 'hello' })
  })

  it('rejects repeated upstream cursors', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(
      trustedConfig({ env: { FAKE_MCP_MODE: 'repeat-cursor' } }),
      false,
    )
    await waitFor(() => manager.listStatuses()[0]?.state === 'error')
    expect(manager.listStatuses()[0]?.lastError).toContain('repeated')
  })

  it('does not launch untrusted config and reports missing host env', async () => {
    const untrusted = trustedConfig()
    delete untrusted.launchTrust
    const stopped = await createManager(untrusted, false)
    expect(stopped.listStatuses()[0]).toMatchObject({
      state: 'untrusted',
      trusted: false,
    })
    expect(stopped.listVisible(process.cwd())).toEqual([])

    const missingEnv = await createManager(trustedConfig(), false)
    await waitFor(() => missingEnv.listStatuses()[0]?.state === 'error')
    expect(missingEnv.listStatuses()[0]?.lastError).toContain(
      'ZCH_MCP_TEST_SECRET',
    )
  })

  it('times out calls without replaying them', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(
      trustedConfig({
        env: { FAKE_MCP_MODE: 'timeout-call' },
        toolTimeoutMs: 100,
      }),
    )
    const catalog = await manager.catalog('fixture', process.cwd())
    await expect(
      manager.callTool({
        serverId: 'fixture',
        workspace: process.cwd(),
        toolName: 'alpha',
        arguments: { value: 'never-returned' },
        expectedRevision: catalog.revision,
      }),
    ).rejects.toThrow(/timed out/iu)
    expect(manager.listStatuses()[0]?.state).toBe('ready')
  })

  it('refreshes revisions after tools/list_changed', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(
      trustedConfig({ env: { FAKE_MCP_MODE: 'list-changed' } }),
    )
    const before = await manager.catalog('fixture', process.cwd())
    await manager.callTool({
      serverId: 'fixture',
      workspace: process.cwd(),
      toolName: 'beta',
      arguments: { count: 1 },
      expectedRevision: before.revision,
    })
    await waitFor(() => manager.listStatuses()[0]?.revision !== before.revision)
    expect(() =>
      manager.resolveTool('fixture', process.cwd(), 'alpha', before.revision),
    ).toThrow(/catalog changed/iu)
  })

  it('restarts once after an unexpected child exit', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const markerDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'zch-mcp-crash-marker-'),
    )
    directories.push(markerDirectory)
    const marker = path.join(markerDirectory, 'crashed')
    const manager = await createManager(
      trustedConfig({
        env: {
          FAKE_MCP_MODE: 'crash-once',
          FAKE_CRASH_MARKER: marker,
        },
      }),
    )
    const firstPid = manager.listStatuses()[0]?.pid
    await waitFor(() => existsSync(marker))
    await waitFor(() => {
      const status = manager.listStatuses()[0]
      return status?.state === 'ready' && status.pid !== firstPid
    })
    expect(manager.listStatuses()[0]).toMatchObject({ state: 'ready' })
  })

  it('restarts a ready connection on demand', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(
      trustedConfig({ env: { FAKE_STARTUP_MARKER: '1' } }),
    )
    const before = manager.listStatuses()[0]?.stderrTail

    await manager.restart('fixture')

    expect(manager.listStatuses()[0]).toMatchObject({ state: 'ready' })
    expect(manager.listStatuses()[0]?.stderrTail).not.toBe(before)
  })

  it('keeps invalid schemas in diagnostics but makes them unavailable', async () => {
    process.env.ZCH_MCP_TEST_SECRET = 'test-secret-value'
    const manager = await createManager(
      trustedConfig({ env: { FAKE_MCP_MODE: 'invalid-schema' } }),
    )
    const catalog = await manager.catalog('fixture', process.cwd())
    expect(catalog.tools[0]).toMatchObject({
      name: 'alpha',
      available: false,
    })
    expect(catalog.diagnostics[0]).toMatchObject({ toolName: 'alpha' })
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for MCP state')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
