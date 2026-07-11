import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { McpServerStatus } from '../../shared/mcp'

export const useMcpStore = defineStore('mcp', {
  state: () => ({
    items: [] as McpServerStatus[],
    loading: false,
    error: '',
  }),
  actions: {
    apply(servers: McpServerStatus[]) {
      this.items = servers
    },
    async run(
      operation: (
        bridge: NonNullable<typeof window.agentApi>,
      ) => ReturnType<NonNullable<typeof window.agentApi>['listMcpServers']>,
    ) {
      const bridge = window.agentApi
      if (!bridge || this.loading) return
      this.loading = true
      this.error = ''
      try {
        const result = await operation(bridge)
        if (result.ok) this.apply(result.value.servers)
        else this.error = result.error.message
      } catch (error) {
        this.error =
          error instanceof Error ? error.message : 'MCP request failed'
      } finally {
        this.loading = false
      }
    },
    load() {
      return this.run((bridge) =>
        bridge.listMcpServers({ version: IPC_VERSION }),
      )
    },
    reload() {
      return this.run((bridge) =>
        bridge.reloadMcpConfig({ version: IPC_VERSION }),
      )
    },
    trustAndEnable(server: McpServerStatus) {
      return this.run((bridge) =>
        bridge.trustAndEnableMcpServer({
          version: IPC_VERSION,
          serverId: server.id,
          fingerprint: server.launchFingerprint,
        }),
      )
    },
    disable(serverId: string) {
      return this.run((bridge) =>
        bridge.disableMcpServer({ version: IPC_VERSION, serverId }),
      )
    },
    restart(server: McpServerStatus) {
      return this.run((bridge) =>
        bridge.restartMcpServer({
          version: IPC_VERSION,
          serverId: server.id,
          workspace: server.workspace,
        }),
      )
    },
  },
})
