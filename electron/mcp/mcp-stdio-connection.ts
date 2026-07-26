import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  CallToolResult,
  Implementation,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { Stream } from 'node:stream'

const MAX_LIST_PAGES = 100
const MAX_TOOLS = 1_000
const MAX_CATALOG_BYTES = 4 * 1_024 * 1_024
const STDERR_BUFFER_CHARS = 32 * 1_024

export interface McpStdioLaunch {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  startupTimeoutMs: number
  redactions: string[]
}

export interface McpConnectionCatalog {
  tools: Tool[]
  instructions?: string
  serverInfo?: Implementation
}

export interface McpStdioConnectionOptions {
  launch: McpStdioLaunch
  onCatalogChanged?: () => void
  onClosed?: () => void
  onError?: (error: unknown) => void
}

/** Encapsulates mcp stdio connection behavior. */
export class McpStdioConnection {
  readonly #launch: McpStdioLaunch
  readonly #onCatalogChanged: () => void
  readonly #onClosed: () => void
  readonly #onError: (error: unknown) => void
  readonly #transport: StdioClientTransport
  readonly #client: Client
  #stderr = ''
  #closed = false

  constructor(options: McpStdioConnectionOptions) {
    this.#launch = options.launch
    this.#onCatalogChanged = options.onCatalogChanged ?? (() => undefined)
    this.#onClosed = options.onClosed ?? (() => undefined)
    this.#onError = options.onError ?? (() => undefined)
    this.#transport = new StdioClientTransport({
      command: this.#launch.command,
      args: this.#launch.args,
      cwd: this.#launch.cwd,
      ...(this.#launch.env ? { env: this.#launch.env } : {}),
      stderr: 'pipe',
    })
    attachStderr(this.#transport.stderr, (chunk) => {
      const sanitized = redact(chunk, this.#launch.redactions)
      this.#stderr = `${this.#stderr}${sanitized}`.slice(-STDERR_BUFFER_CHARS)
    })
    this.#client = new Client(
      { name: 'zch-coding-agent', version: '0.2.3' },
      {
        enforceStrictCapabilities: true,
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => this.#onCatalogChanged(),
          },
        },
      },
    )
    this.#client.onclose = () => {
      if (!this.#closed) this.#onClosed()
    }
    this.#client.onerror = (error) => this.#onError(error)
  }

  /** Returns or updates pid state. */
  get pid(): number | undefined {
    return this.#transport.pid ?? undefined
  }

  /** Returns or updates stderr tail state. */
  get stderrTail(): string {
    return this.#stderr.slice(-8_192)
  }

  /** Returns or updates connect state. */
  async connect(): Promise<McpConnectionCatalog> {
    await this.#client.connect(this.#transport, {
      timeout: this.#launch.startupTimeoutMs,
      maxTotalTimeout: this.#launch.startupTimeoutMs,
    })
    return this.readCatalog(this.#launch.startupTimeoutMs)
  }

  /** Reads catalog. */
  async readCatalog(timeoutMs: number): Promise<McpConnectionCatalog> {
    const tools: Tool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let catalogBytes = 0

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.#client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
      )
      catalogBytes += Buffer.byteLength(JSON.stringify(result), 'utf8')
      if (catalogBytes > MAX_CATALOG_BYTES) {
        throw codedError('MCP_CATALOG_TOO_LARGE', 'MCP catalog exceeds 4 MiB')
      }
      tools.push(...result.tools)
      if (tools.length > MAX_TOOLS) {
        throw codedError(
          'MCP_CATALOG_TOO_LARGE',
          'MCP catalog exceeds 1,000 tools',
        )
      }

      cursor = result.nextCursor
      if (!cursor) {
        return {
          tools,
          instructions: this.#client.getInstructions(),
          serverInfo: this.#client.getServerVersion(),
        }
      }
      if (cursors.has(cursor)) {
        throw codedError(
          'MCP_CURSOR_REPEATED',
          'MCP server repeated a tools/list cursor',
        )
      }
      cursors.add(cursor)
    }

    throw codedError('MCP_CATALOG_TOO_LARGE', 'MCP catalog exceeds 100 pages')
  }

  /** Returns or updates call tool state. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallToolResult> {
    return this.#client.callTool({ name, arguments: args }, undefined, {
      timeout: options.timeoutMs,
      maxTotalTimeout: options.timeoutMs,
      signal: options.signal,
    }) as unknown as Promise<CallToolResult>
  }

  /** Closes the resource and releases its handles. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#client.close().catch(() => this.#transport.close())
  }
}

function attachStderr(
  stream: Stream | null,
  append: (chunk: string) => void,
): void {
  stream?.on('data', (chunk: Buffer | string) => append(String(chunk)))
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce(
      (current, secret) => current.split(secret).join('[redacted]'),
      value,
    )
}
