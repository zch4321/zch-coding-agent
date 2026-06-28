import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Stream } from 'node:stream'
import type {
  CodeBackendStatus,
  CodeIntelligenceCapability,
  CodeIntelligenceResult,
  CodeIntelligenceResultCode,
  CodeRange,
  CodeSymbolItem,
  ProjectModel,
  SerenaBackendConfig,
} from '../../shared/project-model'
import type { CodeIntelligenceBackend, CodeIntelligenceQuery } from './types'

const ALLOWED_SERENA_TOOLS = new Set([
  'get_symbols_overview',
  'find_symbol',
  'find_referencing_symbols',
])
const CAPABILITIES: CodeIntelligenceCapability[] = [
  'symbol_overview',
  'definition',
  'references',
  'workspace_symbols',
]
const MAX_TEXT = 12_000
const MAX_ITEMS = 200

interface SerenaSession {
  client: Client
  transport: StdioClientTransport
  tools: Set<string>
  status: CodeBackendStatus
}

function now() {
  return new Date().toISOString()
}

function errorStatus(
  config: SerenaBackendConfig,
  message: string,
): CodeBackendStatus {
  return {
    backendId: config.id,
    backendKind: 'serena-mcp',
    state: 'error',
    capabilities: CAPABILITIES,
    message,
    updatedAt: now(),
  }
}

function replaceWorkspace(value: string, workspace: string): string {
  return value.replace(/\$\{workspace\}/gu, workspace)
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []

  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    const type = Reflect.get(entry, 'type')
    if (type === 'text' && typeof Reflect.get(entry, 'text') === 'string') {
      chunks.push(String(Reflect.get(entry, 'text')))
    } else if (type === 'resource') {
      const resource = Reflect.get(entry, 'resource')
      if (
        resource &&
        typeof resource === 'object' &&
        typeof Reflect.get(resource, 'text') === 'string'
      ) {
        chunks.push(String(Reflect.get(resource, 'text')))
      }
    }
  }

  return chunks.join('\n')
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = Math.min(
      ...['[', '{']
        .map((char) => trimmed.indexOf(char))
        .filter((index) => index >= 0),
    )
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'))

    if (Number.isFinite(start) && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return undefined
      }
    }

    return undefined
  }
}

function flattenSymbols(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenSymbols)
  if (!value || typeof value !== 'object') return []

  const nested = ['symbols', 'children', 'items', 'result', 'results'].flatMap(
    (key) => {
      const candidate = Reflect.get(value, key)
      return candidate === undefined ? [] : flattenSymbols(candidate)
    },
  )

  return nested.length > 0 ? [value, ...nested] : [value]
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined
}

function rangeFrom(value: unknown): CodeRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const range = Reflect.get(value, 'range')
  const start =
    range && typeof range === 'object' ? Reflect.get(range, 'start') : undefined
  const end =
    range && typeof range === 'object' ? Reflect.get(range, 'end') : undefined
  const startLine =
    asNumber(Reflect.get(value, 'start_line')) ??
    asNumber(Reflect.get(value, 'line')) ??
    (start && typeof start === 'object'
      ? asNumber(Reflect.get(start, 'line'))
      : undefined)
  const startColumn =
    asNumber(Reflect.get(value, 'start_column')) ??
    (start && typeof start === 'object'
      ? asNumber(Reflect.get(start, 'character'))
      : undefined) ??
    1
  const endLine =
    asNumber(Reflect.get(value, 'end_line')) ??
    (end && typeof end === 'object'
      ? asNumber(Reflect.get(end, 'line'))
      : undefined) ??
    startLine
  const endColumn =
    asNumber(Reflect.get(value, 'end_column')) ??
    (end && typeof end === 'object'
      ? asNumber(Reflect.get(end, 'character'))
      : undefined) ??
    startColumn

  return startLine && endLine
    ? { startLine, startColumn, endLine, endColumn }
    : undefined
}

function kindFrom(value: unknown): CodeSymbolItem['kind'] {
  const raw =
    value && typeof value === 'object'
      ? String(
          Reflect.get(value, 'kind') ?? Reflect.get(value, 'symbol_kind') ?? '',
        )
          .toLowerCase()
          .replace(/\s+/gu, '_')
      : ''
  const supported = new Set<CodeSymbolItem['kind']>([
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'struct',
    'type_parameter',
  ])

  return supported.has(raw as CodeSymbolItem['kind'])
    ? (raw as CodeSymbolItem['kind'])
    : 'unknown'
}

function symbolItemFrom(value: unknown): CodeSymbolItem | undefined {
  if (!value || typeof value !== 'object') return undefined
  const name =
    Reflect.get(value, 'name') ??
    Reflect.get(value, 'name_path') ??
    Reflect.get(value, 'name_path_pattern') ??
    Reflect.get(value, 'symbol') ??
    Reflect.get(value, 'symbol_name')

  if (typeof name !== 'string' || !name.trim()) return undefined

  const pathValue =
    Reflect.get(value, 'relative_path') ??
    Reflect.get(value, 'path') ??
    Reflect.get(value, 'file') ??
    Reflect.get(value, 'file_path')
  const context =
    Reflect.get(value, 'context') ??
    Reflect.get(value, 'body') ??
    Reflect.get(value, 'signature')
  const container =
    Reflect.get(value, 'container_name') ?? Reflect.get(value, 'containerName')

  return {
    name: name.slice(0, 512),
    kind: kindFrom(value),
    ...(typeof pathValue === 'string' ? { path: pathValue } : {}),
    ...(rangeFrom(value) ? { range: rangeFrom(value) } : {}),
    ...(typeof container === 'string'
      ? { containerName: container.slice(0, 512) }
      : {}),
    ...(typeof context === 'string'
      ? { context: context.slice(0, 4_096) }
      : {}),
  }
}

function resultFromText(input: {
  backendId: string
  capability: CodeIntelligenceCapability
  text: string
  fallbackName: string
}): CodeIntelligenceResult {
  const truncated = input.text.length > MAX_TEXT
  const preview = input.text.slice(0, MAX_TEXT)
  const parsed = tryParseJson(preview)
  const items = flattenSymbols(parsed)
    .flatMap((value) => {
      const item = symbolItemFrom(value)
      return item ? [item] : []
    })
    .slice(0, MAX_ITEMS)

  if (items.length === 0 && preview.trim()) {
    items.push({
      name: input.fallbackName,
      kind: 'unknown',
      context: preview.trim().slice(0, 4_096),
    })
  }

  return {
    backendId: input.backendId,
    capability: input.capability,
    precision: 'semantic',
    source: 'serena-mcp',
    truncated: truncated || items.length >= MAX_ITEMS,
    items,
  }
}

function unsupported(
  backendId: string,
  capability: CodeIntelligenceCapability,
  message: string,
  code: CodeIntelligenceResultCode,
): CodeIntelligenceResult {
  return {
    backendId,
    capability,
    precision: 'unsupported',
    source: 'serena-mcp',
    truncated: false,
    items: [],
    message,
    code,
  }
}

export class SerenaMcpAdapter implements CodeIntelligenceBackend {
  readonly #sessions = new Map<string, SerenaSession>()
  readonly #starts = new Map<string, Promise<SerenaSession>>()

  status(project: ProjectModel): CodeBackendStatus {
    const session = this.#sessions.get(this.#key(project))
    if (session) return session.status

    return {
      backendId: project.serena.id,
      backendKind: 'serena-mcp',
      state: project.serena.enabled ? 'stopped' : 'not_configured',
      capabilities: CAPABILITIES,
      message: project.serena.enabled
        ? 'Serena backend is configured but not running.'
        : 'Enable Serena in the Project tab to use code intelligence.',
      updatedAt: now(),
    }
  }

  async restart(project: ProjectModel): Promise<CodeBackendStatus> {
    await this.close(project)
    if (!project.serena.enabled) return this.status(project)

    try {
      const session = await this.#start(project)
      return session.status
    } catch (error) {
      const status = errorStatus(
        project.serena,
        error instanceof Error ? error.message : 'Failed to start Serena',
      )
      this.#sessions.delete(this.#key(project))
      return status
    }
  }

  async close(project: ProjectModel): Promise<void> {
    const key = this.#key(project)
    const session = this.#sessions.get(key)
    this.#sessions.delete(key)
    this.#starts.delete(key)
    await session?.transport.close().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#starts.clear()
    await Promise.all(
      sessions.map((session) =>
        session.transport.close().catch(() => undefined),
      ),
    )
  }

  async query(
    project: ProjectModel,
    input: CodeIntelligenceQuery,
  ): Promise<CodeIntelligenceResult> {
    if (!project.serena.enabled) {
      return unsupported(
        project.serena.id,
        input.capability,
        'Serena backend is not enabled for this project.',
        'BACKEND_UNAVAILABLE',
      )
    }

    if (input.capability === 'diagnostics') {
      return unsupported(
        project.serena.id,
        input.capability,
        'Serena diagnostics are not mapped in v1.',
        'UNSUPPORTED_CAPABILITY',
      )
    }

    const session = await this.#start(project)
    const mapped = this.#mapTool(input, session.tools)

    if (!mapped) {
      return unsupported(
        project.serena.id,
        input.capability,
        `Serena does not expose a mapped tool for ${input.capability}.`,
        'UNSUPPORTED_CAPABILITY',
      )
    }

    const result = await session.client.callTool(
      { name: mapped.name, arguments: mapped.arguments },
      undefined,
      { timeout: project.serena.toolTimeoutMs },
    )
    return resultFromText({
      backendId: project.serena.id,
      capability: input.capability,
      text: textFromContent(result.content),
      fallbackName: mapped.name,
    })
  }

  #key(project: ProjectModel): string {
    return `${project.workspaceRoot}:${project.serena.id}`
  }

  async #start(project: ProjectModel): Promise<SerenaSession> {
    const key = this.#key(project)
    const existing = this.#sessions.get(key)
    if (existing) return existing
    const starting = this.#starts.get(key)
    if (starting) return starting

    const operation = this.#connect(project)
    this.#starts.set(key, operation)
    try {
      return await operation
    } finally {
      this.#starts.delete(key)
    }
  }

  async #connect(project: ProjectModel): Promise<SerenaSession> {
    const transport = new StdioClientTransport({
      command: project.serena.command,
      args: project.serena.args.map((arg) =>
        replaceWorkspace(arg, project.workspaceRoot),
      ),
      cwd: project.serena.cwd
        ? replaceWorkspace(project.serena.cwd, project.workspaceRoot)
        : project.workspaceRoot,
      stderr: 'pipe',
    })
    const stderr = transport.stderr
    const stderrChunks: string[] = []
    attachStderr(stderr, stderrChunks)

    const client = new Client({
      name: 'zch-coding-agent',
      version: '0.1.2',
    })
    await client.connect(transport, {
      timeout: project.serena.startupTimeoutMs,
    })
    const tools = new Set(
      (
        await client.listTools(undefined, {
          timeout: project.serena.startupTimeoutMs,
        })
      ).tools.map((tool) => tool.name),
    )
    const status: CodeBackendStatus = {
      backendId: project.serena.id,
      backendKind: 'serena-mcp',
      state: 'ready',
      capabilities: CAPABILITIES,
      pid: transport.pid ?? undefined,
      message:
        stderrChunks.length > 0
          ? stderrChunks.join('\n').slice(-2_000)
          : 'Serena backend is ready.',
      updatedAt: now(),
    }
    const session = { client, transport, tools, status }
    this.#sessions.set(this.#key(project), session)
    return session
  }

  #mapTool(
    input: CodeIntelligenceQuery,
    tools: ReadonlySet<string>,
  ): { name: string; arguments: Record<string, unknown> } | undefined {
    const relativePath = input.path ?? '.'
    const symbol = input.symbolName ?? input.query ?? ''

    switch (input.capability) {
      case 'symbol_overview':
        return tool('get_symbols_overview', tools, {
          relative_path: relativePath,
          max_answer_chars: MAX_TEXT,
        })
      case 'definition':
        if (!symbol) return undefined
        return tool('find_symbol', tools, {
          name_path_pattern: symbol,
          relative_path: relativePath,
          include_body: false,
          substring_matching: true,
          max_answer_chars: MAX_TEXT,
        })
      case 'references':
        if (!symbol) return undefined
        return tool('find_referencing_symbols', tools, {
          name_path: symbol,
          relative_path: relativePath,
          max_answer_chars: MAX_TEXT,
        })
      case 'workspace_symbols':
        if (!symbol) return undefined
        return tool('find_symbol', tools, {
          name_path_pattern: symbol,
          relative_path: relativePath,
          include_body: false,
          substring_matching: true,
          max_answer_chars: MAX_TEXT,
        })
      default:
        return undefined
    }
  }
}

function tool(
  name: string,
  tools: ReadonlySet<string>,
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } | undefined {
  return ALLOWED_SERENA_TOOLS.has(name) && tools.has(name)
    ? { name, arguments: args }
    : undefined
}

function attachStderr(stderr: Stream | null, chunks: string[]): void {
  stderr?.on('data', (chunk: Buffer | string) => {
    chunks.push(String(chunk).slice(0, 2_000))
    while (chunks.join('\n').length > 4_000) {
      chunks.shift()
    }
  })
}
