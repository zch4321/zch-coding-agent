// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { McpServerStatus } from '../../shared/mcp'
import { installApi, setupAgentTest } from './agent-test-support'
import { useMcpStore } from './mcp'

const server: McpServerStatus = {
  id: 'fixture',
  label: 'Fixture',
  description: 'Fixture server',
  enabled: false,
  scope: 'global',
  state: 'untrusted',
  trusted: false,
  launchFingerprint: 'a'.repeat(64),
  launchPreview: 'command: node fixture.mjs',
  toolCount: 0,
  stderrTail: '',
}

describe('MCP settings store', () => {
  setupAgentTest()

  it('loads status and sends the displayed fingerprint when trusting', async () => {
    const listMcpServers = vi.fn(async () => success([server]))
    const trustAndEnableMcpServer = vi.fn(
      async (payload: Parameters<AgentApi['trustAndEnableMcpServer']>[0]) => {
        expect(payload).toMatchObject({
          serverId: 'fixture',
          fingerprint: server.launchFingerprint,
        })
        return success([{ ...server, enabled: true, trusted: true }])
      },
    )
    installApi({ listMcpServers, trustAndEnableMcpServer })
    const store = useMcpStore()

    await store.load()
    expect(store.items).toEqual([server])
    await store.trustAndEnable(server)
    expect(store.items[0]).toMatchObject({ enabled: true, trusted: true })
  })
})

function success(servers: McpServerStatus[]) {
  return {
    version: 1 as const,
    ok: true as const,
    value: { servers },
  }
}
