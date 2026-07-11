import { createHash } from 'node:crypto'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { JsonValue } from '../../shared/json'
import type {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
} from '../../shared/mcp'
import type { ConfigStore } from '../config/store'
import {
  McpStdioConnection,
  type McpConnectionCatalog,
  type McpStdioLaunch,
} from './mcp-stdio-connection'

const TOOL_DEFINITION_BYTES = 32 * 1_024
const MAX_INSTRUCTIONS_CHARS = 16 * 1_024
const MAX_RESTART_ATTEMPTS = 5

export interface McpToolDescriptor {
  name: string
  title?: string
  description?: string
  inputSchema: JsonValue
  outputSchema?: JsonValue
  annotations?: JsonValue
  available: boolean
  diagnostic?: string
}

interface CatalogTool extends McpToolDescriptor {
  validateInput?: ValidateFunction
  validateOutput?: ValidateFunction
}

export interface McpCatalogSnapshot {
  server: {
    id: string
    label: string
    description: string
    scope: McpServerConfig['scope']
    state: McpServerState
    implementation?: JsonValue
  }
  serverId: string
  revision: string
  instructions?: string
  tools: McpToolDescriptor[]
  diagnostics: Array<{ toolName: string; code: string; message: string }>
}

interface InternalCatalog extends Omit<McpCatalogSnapshot, 'server' | 'tools'> {
  tools: CatalogTool[]
  byName: Map<string, CatalogTool>
  serverInfo?: JsonValue
}

interface ManagedConnection {
  key: string
  serverId: string
  workspace?: string
  fingerprint: string
  state: McpServerState
  connection?: McpStdioConnection
  catalog?: InternalCatalog
  starting?: Promise<void>
  activeCalls: number
  stopRequested: boolean
  intentionalClose: boolean
  restartAttempts: number
  restartTimer?: ReturnType<typeof setTimeout>
  lastError?: string
}

export interface McpManagerOptions {
  configStore: ConfigStore
  defaultCwd: string
  onDiagnostic?: (message: string, error?: unknown) => void
}

export class McpManager {
  readonly #configStore: ConfigStore
  readonly #defaultCwd: string
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #configs = new Map<string, McpServerConfig>()
  readonly #connections = new Map<string, ManagedConnection>()
  readonly #activeWorkspaces = new Set<string>()
  #disposed = false

  constructor(options: McpManagerOptions) {
    this.#configStore = options.configStore
    this.#defaultCwd = options.defaultCwd
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  async initialize(): Promise<void> {
    await this.#applyConfigs(this.#configStore.getMcpServers())
  }

  async activateWorkspace(workspace: string): Promise<void> {
    const canonical = path.resolve(workspace)
    this.#activeWorkspaces.add(canonical)
    await this.#applyConfigs(this.#configStore.getMcpServers())
  }

  async reload(): Promise<McpServerStatus[]> {
    await this.#configStore.reloadFromDisk()
    await this.#applyConfigs(this.#configStore.getMcpServers())
    return this.listStatuses()
  }

  async trustAndEnable(
    serverId: string,
    fingerprint: string,
  ): Promise<McpServerStatus[]> {
    const config = this.#requireConfig(serverId)
    const expected = launchFingerprint(config)
    if (fingerprint !== expected) {
      throw codedError(
        'MCP_LAUNCH_CHANGED',
        'MCP launch configuration changed before it was trusted',
      )
    }
    await this.#configStore.setMcpServerEnabled(serverId, true, {
      fingerprint,
      trustedAt: new Date().toISOString(),
    })
    await this.#applyConfigs(this.#configStore.getMcpServers())
    return this.listStatuses()
  }

  async disable(serverId: string): Promise<McpServerStatus[]> {
    this.#requireConfig(serverId)
    await this.#configStore.setMcpServerEnabled(serverId, false)
    await this.#applyConfigs(this.#configStore.getMcpServers())
    return this.listStatuses()
  }

  async restart(
    serverId: string,
    workspace?: string,
  ): Promise<McpServerStatus[]> {
    const config = this.#requireConfig(serverId)
    if (!isTrusted(config)) {
      throw codedError('MCP_SERVER_UNTRUSTED', 'Trust this MCP server first')
    }
    const records = this.#recordsFor(serverId, workspace)
    if (records.length === 0 && config.scope === 'global') {
      records.push(this.#ensureRecord(config))
    }
    await Promise.all(records.map((record) => this.#restartRecord(record)))
    return this.listStatuses()
  }

  listStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = []
    for (const config of [...this.#configs.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const records = this.#recordsFor(config.id)
      if (records.length === 0) {
        statuses.push(this.#statusFor(config))
      } else {
        statuses.push(
          ...records.map((record) => this.#statusFor(config, record)),
        )
      }
    }
    return statuses
  }

  listVisible(workspace: string): McpServerStatus[] {
    return this.listStatuses().filter((status) => {
      if (!status.enabled || !status.trusted) return false
      if (status.scope === 'global') return true
      return status.workspace === path.resolve(workspace)
    })
  }

  async catalog(
    serverId: string,
    workspace: string,
  ): Promise<McpCatalogSnapshot> {
    const config = this.#requireVisibleConfig(serverId)
    const record = this.#ensureRecord(
      config,
      config.scope === 'workspace' ? path.resolve(workspace) : undefined,
    )
    await this.#start(record)
    if (!record.catalog) {
      throw codedError(
        'MCP_SERVER_NOT_AVAILABLE',
        record.lastError ?? 'MCP server catalog is unavailable',
      )
    }
    return publicCatalog(record.catalog, config, record)
  }

  resolveTool(
    serverId: string,
    workspace: string,
    toolName: string,
    expectedRevision: string,
  ): { descriptor: McpToolDescriptor; validate: ValidateFunction } {
    const config = this.#requireVisibleConfig(serverId)
    const record = this.#ensureRecord(
      config,
      config.scope === 'workspace' ? path.resolve(workspace) : undefined,
    )
    if (!record.catalog || record.catalog.revision !== expectedRevision) {
      throw codedError(
        'MCP_CATALOG_CHANGED',
        'MCP catalog changed; read the server again before calling a tool',
      )
    }
    const tool = record.catalog.byName.get(toolName)
    if (!tool?.available || !tool.validateInput) {
      throw codedError(
        'MCP_TOOL_NOT_AVAILABLE',
        tool?.diagnostic ?? `MCP tool was not found: ${toolName}`,
      )
    }
    return { descriptor: publicTool(tool), validate: tool.validateInput }
  }

  async callTool(input: {
    serverId: string
    workspace: string
    toolName: string
    arguments: Record<string, unknown>
    expectedRevision: string
    signal?: AbortSignal
  }): Promise<CallToolResult> {
    const config = this.#requireVisibleConfig(input.serverId)
    const record = this.#ensureRecord(
      config,
      config.scope === 'workspace' ? path.resolve(input.workspace) : undefined,
    )
    const resolved = this.resolveTool(
      input.serverId,
      input.workspace,
      input.toolName,
      input.expectedRevision,
    )
    if (!resolved.validate(input.arguments)) {
      throw codedError(
        'MCP_INVALID_ARGS',
        'MCP tool arguments failed validation',
      )
    }
    await this.#start(record)
    const connection = record.connection
    if (!connection) {
      throw codedError('MCP_SERVER_NOT_AVAILABLE', 'MCP server is unavailable')
    }

    record.activeCalls += 1
    try {
      const result = await connection.callTool(
        input.toolName,
        input.arguments,
        {
          timeoutMs: config.toolTimeoutMs,
          signal: input.signal,
        },
      )
      const internal = record.catalog?.byName.get(input.toolName)
      if (
        internal?.validateOutput &&
        result.structuredContent &&
        !internal.validateOutput(result.structuredContent)
      ) {
        throw codedError(
          'MCP_INVALID_OUTPUT',
          'MCP structured output failed its declared output schema',
        )
      }
      return result
    } finally {
      record.activeCalls -= 1
      if (record.stopRequested && record.activeCalls === 0) {
        await this.#stop(record)
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.all(
      [...this.#connections.values()].map((record) => this.#stop(record)),
    )
    this.#connections.clear()
    this.#configs.clear()
  }

  async #applyConfigs(configs: McpServerConfig[]): Promise<void> {
    const ids = new Set<string>()
    for (const config of configs) {
      if (ids.has(config.id)) {
        throw codedError(
          'MCP_DUPLICATE_SERVER',
          `Duplicate MCP server id: ${config.id}`,
        )
      }
      ids.add(config.id)
    }

    const next = new Map(
      configs.map((config) => [config.id, structuredClone(config)]),
    )
    this.#configs.clear()
    for (const [id, config] of next) this.#configs.set(id, config)

    for (const record of this.#connections.values()) {
      const config = next.get(record.serverId)
      if (
        !config ||
        !config.enabled ||
        !isTrusted(config) ||
        record.fingerprint !== launchFingerprint(config)
      ) {
        void this.#requestStop(record)
      }
    }

    for (const config of configs) {
      if (!config.enabled || !isTrusted(config)) continue
      if (config.scope === 'global') {
        void this.#start(this.#ensureRecord(config))
      } else {
        for (const workspace of this.#activeWorkspaces) {
          void this.#start(this.#ensureRecord(config, workspace))
        }
      }
    }
  }

  #ensureRecord(
    config: McpServerConfig,
    workspace?: string,
  ): ManagedConnection {
    const key = connectionKey(config.id, workspace)
    const fingerprint = launchFingerprint(config)
    const existing = this.#connections.get(key)
    if (existing && existing.fingerprint === fingerprint) return existing
    const record: ManagedConnection = {
      key,
      serverId: config.id,
      workspace,
      fingerprint,
      state: config.enabled
        ? isTrusted(config)
          ? 'stopped'
          : 'untrusted'
        : 'disabled',
      activeCalls: 0,
      stopRequested: false,
      intentionalClose: false,
      restartAttempts: 0,
    }
    this.#connections.set(key, record)
    if (existing) void this.#requestStop(existing)
    return record
  }

  async #start(record: ManagedConnection): Promise<void> {
    if (this.#disposed || record.state === 'ready') return
    if (record.starting) return record.starting
    const config = this.#configs.get(record.serverId)
    if (
      !config?.enabled ||
      !isTrusted(config) ||
      record.fingerprint !== launchFingerprint(config)
    ) {
      record.state = config?.enabled ? 'untrusted' : 'disabled'
      return
    }

    const operation = this.#connect(record, config)
    record.starting = operation
    try {
      await operation
    } finally {
      record.starting = undefined
    }
  }

  async #connect(
    record: ManagedConnection,
    config: McpServerConfig,
  ): Promise<void> {
    record.state = record.restartAttempts > 0 ? 'restarting' : 'starting'
    record.intentionalClose = false
    record.stopRequested = false
    try {
      const launch = resolveLaunch(config, record.workspace, this.#defaultCwd)
      const connection = new McpStdioConnection({
        launch,
        onCatalogChanged: () => void this.#refreshCatalog(record),
        onClosed: () => this.#handleUnexpectedClose(record),
        onError: (error) =>
          this.#onDiagnostic(`MCP ${record.serverId} transport error`, error),
      })
      record.connection = connection
      const catalog = await connection.connect()
      record.catalog = normalizeCatalog(config.id, catalog)
      record.state = 'ready'
      record.lastError = undefined
      record.restartAttempts = 0
    } catch (error) {
      record.state = 'error'
      record.lastError = error instanceof Error ? error.message : String(error)
      await record.connection?.close().catch(() => undefined)
      record.connection = undefined
      this.#onDiagnostic(`MCP ${record.serverId} failed to start`, error)
    }
  }

  async #refreshCatalog(record: ManagedConnection): Promise<void> {
    const config = this.#configs.get(record.serverId)
    if (!config || !record.connection || record.state !== 'ready') return
    try {
      const catalog = await record.connection.readCatalog(
        config.startupTimeoutMs,
      )
      record.catalog = normalizeCatalog(config.id, catalog)
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error)
      this.#onDiagnostic(`MCP ${record.serverId} catalog refresh failed`, error)
    }
  }

  #handleUnexpectedClose(record: ManagedConnection): void {
    record.connection = undefined
    if (this.#disposed || record.intentionalClose) return
    const config = this.#configs.get(record.serverId)
    if (!config?.enabled || !isTrusted(config)) {
      record.state = config?.enabled ? 'untrusted' : 'disabled'
      return
    }
    if (record.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      record.state = 'error'
      record.lastError = 'MCP server exited repeatedly'
      return
    }
    record.restartAttempts += 1
    record.state = 'restarting'
    const delay = Math.min(30_000, 500 * 2 ** (record.restartAttempts - 1))
    record.restartTimer = setTimeout(() => void this.#start(record), delay)
  }

  async #requestStop(record: ManagedConnection): Promise<void> {
    clearTimeout(record.restartTimer)
    record.restartTimer = undefined
    if (record.activeCalls > 0) {
      record.stopRequested = true
      record.state = 'draining'
      return
    }
    await this.#stop(record)
  }

  async #stop(record: ManagedConnection): Promise<void> {
    clearTimeout(record.restartTimer)
    record.restartTimer = undefined
    record.stopRequested = false
    record.intentionalClose = true
    await record.connection?.close().catch(() => undefined)
    record.connection = undefined
    record.catalog = undefined
    const config = this.#configs.get(record.serverId)
    record.state = !config?.enabled
      ? 'disabled'
      : isTrusted(config)
        ? 'stopped'
        : 'untrusted'
  }

  async #restartRecord(record: ManagedConnection): Promise<void> {
    await this.#requestStop(record)
    if (record.state === 'draining') return
    record.restartAttempts = 0
    await this.#start(record)
  }

  #recordsFor(serverId: string, workspace?: string): ManagedConnection[] {
    const canonical = workspace ? path.resolve(workspace) : undefined
    return [...this.#connections.values()].filter(
      (record) =>
        record.serverId === serverId &&
        (canonical === undefined || record.workspace === canonical),
    )
  }

  #requireConfig(serverId: string): McpServerConfig {
    const config = this.#configs.get(serverId)
    if (!config)
      throw codedError(
        'MCP_SERVER_NOT_FOUND',
        `MCP server not found: ${serverId}`,
      )
    return config
  }

  #requireVisibleConfig(serverId: string): McpServerConfig {
    const config = this.#requireConfig(serverId)
    if (!config.enabled || !isTrusted(config)) {
      throw codedError(
        'MCP_SERVER_NOT_AVAILABLE',
        'MCP server is not enabled and trusted',
      )
    }
    return config
  }

  #statusFor(
    config: McpServerConfig,
    record?: ManagedConnection,
  ): McpServerStatus {
    const fingerprint = launchFingerprint(config)
    const trusted = config.launchTrust?.fingerprint === fingerprint
    return {
      id: config.id,
      label: config.label,
      description: config.description,
      enabled: config.enabled,
      scope: config.scope,
      state:
        record?.state ??
        (config.enabled ? (trusted ? 'stopped' : 'untrusted') : 'disabled'),
      trusted,
      launchFingerprint: fingerprint,
      launchPreview: launchPreview(config, record?.workspace, this.#defaultCwd),
      pid: record?.connection?.pid,
      toolCount: record?.catalog?.tools.length ?? 0,
      revision: record?.catalog?.revision,
      stderrTail: record?.connection?.stderrTail ?? '',
      lastError: record?.lastError,
      workspace: record?.workspace,
    }
  }
}

export function launchFingerprint(config: McpServerConfig): string {
  const stable = {
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    scope: config.scope,
    env: sortedRecord(config.env),
    envFromHost: sortedRecord(config.envFromHost),
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function isTrusted(config: McpServerConfig): boolean {
  return config.launchTrust?.fingerprint === launchFingerprint(config)
}

function resolveLaunch(
  config: McpServerConfig,
  workspace: string | undefined,
  defaultCwd: string,
): McpStdioLaunch {
  if (config.scope === 'workspace' && !workspace) {
    throw codedError(
      'MCP_WORKSPACE_REQUIRED',
      'Workspace MCP server requires a workspace',
    )
  }
  const replace = (value: string) =>
    value.replaceAll('${workspace}', workspace ?? '')
  const env = { ...(config.env ?? {}) }
  const redactions: string[] = []
  for (const [childName, hostName] of Object.entries(
    config.envFromHost ?? {},
  )) {
    const value = process.env[hostName]
    if (value === undefined) {
      throw codedError(
        'MCP_ENV_MISSING',
        `Required host environment variable is missing: ${hostName}`,
      )
    }
    env[childName] = value
    redactions.push(value)
  }
  return {
    command: replace(config.command),
    args: config.args.map(replace),
    cwd: replace(
      config.cwd ?? (config.scope === 'workspace' ? workspace! : defaultCwd),
    ),
    env,
    startupTimeoutMs: config.startupTimeoutMs,
    redactions,
  }
}

function launchPreview(
  config: McpServerConfig,
  workspace: string | undefined,
  defaultCwd: string,
): string {
  const displayWorkspace = workspace ?? '${workspace}'
  const replace = (value: string) =>
    value.replaceAll('${workspace}', displayWorkspace)
  const cwd = replace(
    config.cwd ??
      (config.scope === 'workspace' ? displayWorkspace : defaultCwd),
  )
  const command = [replace(config.command), ...config.args.map(replace)]
    .map(quoteArg)
    .join(' ')
  const env = [
    ...Object.keys(config.env ?? {}).map((key) => `${key}=[configured]`),
    ...Object.entries(config.envFromHost ?? {}).map(
      ([key, source]) => `${key}=[host:${source}]`,
    ),
  ]
  return [
    `command: ${command}`,
    `cwd: ${cwd}`,
    `env: ${env.join(', ') || '(none)'}`,
  ].join('\n')
}

function normalizeCatalog(
  serverId: string,
  catalog: McpConnectionCatalog,
): InternalCatalog {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const names = new Set<string>()
  const diagnostics: InternalCatalog['diagnostics'] = []
  const tools = [...catalog.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool): CatalogTool => {
      if (names.has(tool.name)) {
        throw codedError(
          'MCP_DUPLICATE_TOOL',
          `Duplicate MCP tool name: ${tool.name}`,
        )
      }
      names.add(tool.name)
      const raw = jsonValue(tool)
      const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8')
      const descriptor: CatalogTool = {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        inputSchema: jsonValue(tool.inputSchema),
        outputSchema: tool.outputSchema
          ? jsonValue(tool.outputSchema)
          : undefined,
        annotations: tool.annotations ? jsonValue(tool.annotations) : undefined,
        available: true,
      }
      if (bytes > TOOL_DEFINITION_BYTES) {
        descriptor.available = false
        descriptor.diagnostic = 'Tool definition exceeds 32 KiB'
      } else {
        try {
          descriptor.validateInput = ajv.compile(tool.inputSchema)
          if (tool.outputSchema)
            descriptor.validateOutput = ajv.compile(tool.outputSchema)
        } catch (error) {
          descriptor.available = false
          descriptor.diagnostic =
            error instanceof Error ? error.message : 'Tool schema is invalid'
        }
      }
      if (!descriptor.available) {
        diagnostics.push({
          toolName: tool.name,
          code: 'MCP_TOOL_SCHEMA_UNSUPPORTED',
          message: descriptor.diagnostic ?? 'Tool schema is unavailable',
        })
      }
      return descriptor
    })
  const instructions = catalog.instructions?.slice(0, MAX_INSTRUCTIONS_CHARS)
  const revision = createHash('sha256')
    .update(
      JSON.stringify({ serverId, instructions, tools: tools.map(publicTool) }),
    )
    .digest('hex')
  return {
    serverId,
    revision,
    instructions,
    tools,
    diagnostics,
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    serverInfo: catalog.serverInfo ? jsonValue(catalog.serverInfo) : undefined,
  }
}

function publicCatalog(
  catalog: InternalCatalog,
  config: McpServerConfig,
  record: ManagedConnection,
): McpCatalogSnapshot {
  return {
    server: {
      id: config.id,
      label: config.label,
      description: config.description,
      scope: config.scope,
      state: record.state,
      implementation: catalog.serverInfo
        ? structuredClone(catalog.serverInfo)
        : undefined,
    },
    serverId: catalog.serverId,
    revision: catalog.revision,
    instructions: catalog.instructions,
    tools: catalog.tools.map(publicTool),
    diagnostics: structuredClone(catalog.diagnostics),
  }
}

function publicTool(tool: CatalogTool): McpToolDescriptor {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    outputSchema: tool.outputSchema
      ? structuredClone(tool.outputSchema)
      : undefined,
    annotations: tool.annotations
      ? structuredClone(tool.annotations)
      : undefined,
    available: tool.available,
    diagnostic: tool.diagnostic,
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function publicCatalogKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function connectionKey(serverId: string, workspace?: string): string {
  return workspace
    ? `${serverId}::${publicCatalogKey(path.resolve(workspace))}`
    : `${serverId}::global`
}

function sortedRecord(
  value: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  )
}

function quoteArg(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
