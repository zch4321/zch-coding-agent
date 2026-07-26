import { Type, type Static } from '@sinclair/typebox'
import { JsonValueSchema, type JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type {
  McpCatalogSnapshot,
  McpManager,
  McpToolDescriptor,
} from '../mcp/mcp-manager'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type { SessionState } from '../session/session-types'
import type { ToolCall, ToolDefinition, ToolResult } from './types'
import type { ToolRegistry } from './tool-registry'
import type { SessionId } from '../../shared/ids'

export const MCP_CALL_TOOL_ID = 'call_mcp_tool'

const ListMcpServersSchema = Type.Object({}, { additionalProperties: false })
const ReadMcpServerSchema = Type.Object(
  {
    serverId: Type.String({ minLength: 1, maxLength: 64 }),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  },
  { additionalProperties: false },
)
const CallMcpToolSchema = Type.Object(
  {
    serverId: Type.String({ minLength: 1, maxLength: 64 }),
    toolName: Type.String({ minLength: 1, maxLength: 256 }),
    arguments: Type.Record(Type.String({ maxLength: 256 }), JsonValueSchema, {
      maxProperties: 1_000,
    }),
  },
  { additionalProperties: false },
)
type CallMcpToolArgs = Static<typeof CallMcpToolSchema>

interface CursorPayload {
  version: 1
  serverId: string
  revision: string
  offset: number
}

export type McpCallResolution =
  | { matched: false }
  | { matched: true; ok: false; result: ToolResult }
  | {
      matched: true
      ok: true
      call: ToolCall
      definition: ToolDefinition
    }

/** Mediates MCP tool resolution, catalog revisions, and permission-aware calls. */
export class McpToolGateway {
  readonly #manager: McpManager
  readonly #configStore: ConfigStore
  readonly #validateCall = compileSchema(CallMcpToolSchema)

  constructor(manager: McpManager, configStore: ConfigStore) {
    this.#manager = manager
    this.#configStore = configStore
  }

  /** Recognizes an MCP call tool and validates its arguments and visible server. */
  resolveCall(session: SessionState, call: ToolCall): McpCallResolution {
    if (call.toolId !== MCP_CALL_TOOL_ID) return { matched: false }
    if (!this.#validateCall(call.args)) {
      return {
        matched: true,
        ok: false,
        result: {
          status: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: formatSchemaErrors(this.#validateCall.errors),
          retryable: false,
        },
      }
    }
    const args = call.args as CallMcpToolArgs
    const disclosure = session.mcpDisclosures.get(args.serverId)
    if (!disclosure?.toolNames.has(args.toolName)) {
      return {
        matched: true,
        ok: false,
        result: {
          status: 'error',
          code: 'MCP_TOOL_NOT_DISCLOSED',
          message:
            'Read the page containing this MCP tool with read_mcp_server before calling it',
          retryable: false,
        },
      }
    }

    try {
      const resolved = this.#manager.resolveTool(
        args.serverId,
        session.workspace,
        args.toolName,
        disclosure.revision,
      )
      if (!resolved.validate(args.arguments)) {
        return {
          matched: true,
          ok: false,
          result: {
            status: 'error',
            code: 'MCP_INVALID_ARGS',
            message: formatSchemaErrors(resolved.validate.errors),
            retryable: false,
          },
        }
      }
      const canonicalId = `mcp:${args.serverId}:${args.toolName}`
      const effectiveCall: ToolCall = {
        ...call,
        toolId: canonicalId,
        args: structuredClone(args.arguments) as JsonValue,
      }
      const permissiveSchema = Type.Unsafe<Record<string, JsonValue>>({})
      const definition: ToolDefinition = {
        id: canonicalId,
        description: mcpToolDescription(args.serverId, resolved.descriptor),
        inputSchema: permissiveSchema,
        effects: ['external.unknown'],
        defaultRisk: 'review',
        supportsAbort: false,
        defaultTimeoutMs:
          this.#configStore.getPublicConfig().limits.commandTimeoutMs,
        maxOutputBytes:
          this.#configStore.getPublicConfig().limits.maxToolOutputBytes,
        validateArgs: (value) =>
          resolved.validate(value)
            ? undefined
            : formatSchemaErrors(resolved.validate.errors),
        execute: async (value) => {
          try {
            const result = await this.#manager.callTool({
              serverId: args.serverId,
              workspace: session.workspace,
              toolName: args.toolName,
              arguments: value as Record<string, unknown>,
              expectedRevision: disclosure.revision,
            })
            return normalizeMcpResult(result)
          } catch (error) {
            return failureResult(error)
          }
        },
      }
      return { matched: true, ok: true, call: effectiveCall, definition }
    } catch (error) {
      return { matched: true, ok: false, result: failureResult(error) }
    }
  }
}

/** Registers MCP catalog and call tools with the ToolRegistry. */
export function registerMcpTools(
  registry: ToolRegistry,
  options: {
    manager: McpManager
    configStore: ConfigStore
    getSession: (sessionId: SessionId) => SessionState | undefined
  },
): McpToolGateway {
  registry.registerTool({
    id: 'list_mcp_servers',
    description:
      'List MCP servers the user enabled for this workspace. Use this to discover external integrations before reading one server.',
    inputSchema: ListMcpServersSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 2_000,
    maxOutputBytes: 32 * 1_024,
    async execute(_args, context) {
      return {
        status: 'ok',
        content: {
          servers: options.manager
            .listVisible(context.workspace.canonicalPath)
            .map((server) => ({
              id: server.id,
              label: server.label,
              description: server.description,
              scope: server.scope,
              state: server.state,
              toolCount: server.toolCount,
            })),
        },
      }
    },
  })

  registry.registerTool({
    id: 'read_mcp_server',
    description:
      'Read a paginated catalog from one user-enabled external MCP server, including server-provided instructions and full tool schemas. Continue with nextCursor until the needed tool is returned before using call_mcp_tool.',
    inputSchema: ReadMcpServerSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 30_000,
    maxOutputBytes:
      options.configStore.getPublicConfig().limits.maxToolOutputBytes,
    async execute(args, context) {
      const session = options.getSession(context.sessionId)
      if (!session) {
        return {
          status: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Session is no longer available',
          retryable: false,
        }
      }
      try {
        const catalog = await options.manager.catalog(
          args.serverId,
          context.workspace.canonicalPath,
        )
        const cursor = args.cursor ? decodeCursor(args.cursor) : undefined
        if (cursor && cursor.serverId !== args.serverId) {
          throw codedError(
            'MCP_CURSOR_INVALID',
            'Cursor belongs to another MCP server',
          )
        }
        if (cursor && cursor.revision !== catalog.revision) {
          throw codedError(
            'MCP_CURSOR_STALE',
            'MCP catalog changed; restart pagination',
          )
        }
        const offset = cursor?.offset ?? 0
        if (offset < 0 || offset > catalog.tools.length) {
          throw codedError('MCP_CURSOR_INVALID', 'Cursor offset is invalid')
        }
        const maxBytes =
          options.configStore.getPublicConfig().limits.maxToolOutputBytes
        const page = buildPage(catalog, offset, args.limit ?? 10, maxBytes)
        const current = session.mcpDisclosures.get(args.serverId)
        const disclosure =
          current?.revision === catalog.revision
            ? current
            : { revision: catalog.revision, toolNames: new Set<string>() }
        for (const tool of page.tools) {
          if (tool.available) disclosure.toolNames.add(tool.name)
        }
        session.mcpDisclosures.set(args.serverId, disclosure)
        return { status: 'ok', content: page.content }
      } catch (error) {
        return failureResult(error)
      }
    },
  } satisfies ToolDefinition<typeof ReadMcpServerSchema>)

  registry.registerTool({
    id: MCP_CALL_TOOL_ID,
    description:
      'Call one tool from a user-enabled MCP server after read_mcp_server returned that exact tool and schema. The runtime validates and authorizes the real MCP tool before execution.',
    inputSchema: CallMcpToolSchema,
    effects: ['external.unknown'],
    defaultRisk: 'review',
    supportsAbort: false,
    defaultTimeoutMs: 120_000,
    maxOutputBytes: 64 * 1_024,
    async execute() {
      return {
        status: 'error',
        code: 'MCP_GATEWAY_NOT_RESOLVED',
        message: 'MCP gateway call was not resolved before execution',
        retryable: false,
      }
    },
  } satisfies ToolDefinition<typeof CallMcpToolSchema>)

  return new McpToolGateway(options.manager, options.configStore)
}

function buildPage(
  catalog: McpCatalogSnapshot,
  offset: number,
  limit: number,
  maxBytes: number,
): { tools: McpToolDescriptor[]; content: JsonValue } {
  const tools: McpToolDescriptor[] = []
  let index = offset
  while (index < catalog.tools.length && tools.length < limit) {
    const candidate = [...tools, catalog.tools[index]]
    const content = pageContent(catalog, offset, index + 1, candidate)
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > maxBytes) {
      if (tools.length === 0) {
        const oversized = unavailablePageTool(catalog.tools[index])
        const diagnosticContent = pageContent(catalog, offset, index + 1, [
          oversized,
        ])
        if (
          Buffer.byteLength(JSON.stringify(diagnosticContent), 'utf8') >
          maxBytes
        ) {
          throw codedError(
            'MCP_PAGE_BUDGET_TOO_SMALL',
            'The configured tool output limit cannot fit MCP page metadata',
          )
        }
        tools.push(oversized)
        index += 1
      }
      break
    }
    tools.push(catalog.tools[index])
    index += 1
  }
  return { tools, content: pageContent(catalog, offset, index, tools) }
}

function pageContent(
  catalog: McpCatalogSnapshot,
  offset: number,
  nextOffset: number,
  tools: McpToolDescriptor[],
): JsonValue {
  return {
    server: catalog.server,
    serverId: catalog.serverId,
    revision: catalog.revision,
    totalTools: catalog.tools.length,
    offset,
    ...(offset === 0 && catalog.instructions
      ? { instructions: catalog.instructions }
      : {}),
    tools: tools as unknown as JsonValue[],
    diagnostics: tools
      .filter((tool) => !tool.available)
      .map((tool) => ({
        toolName: tool.name,
        code: 'MCP_TOOL_SCHEMA_UNSUPPORTED',
        message: tool.diagnostic ?? 'Tool is unavailable',
      })),
    ...(nextOffset < catalog.tools.length
      ? {
          nextCursor: encodeCursor({
            version: 1,
            serverId: catalog.serverId,
            revision: catalog.revision,
            offset: nextOffset,
          }),
        }
      : {}),
  }
}

function unavailablePageTool(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description?.slice(0, 512),
    inputSchema: {},
    available: false,
    diagnostic: 'Tool definition exceeds the configured MCP catalog page limit',
  }
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string): CursorPayload {
  try {
    const candidate = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<CursorPayload>
    if (
      candidate.version !== 1 ||
      typeof candidate.serverId !== 'string' ||
      typeof candidate.revision !== 'string' ||
      !Number.isInteger(candidate.offset)
    ) {
      throw new Error('Invalid cursor')
    }
    return candidate as CursorPayload
  } catch {
    throw codedError('MCP_CURSOR_INVALID', 'MCP catalog cursor is invalid')
  }
}

function mcpToolDescription(serverId: string, tool: McpToolDescriptor): string {
  const hints = tool.annotations
    ? ` Risk hints: ${JSON.stringify(tool.annotations)}`
    : ''
  return `External MCP tool ${serverId}/${tool.name}. ${tool.description ?? ''}${hints}`.slice(
    0,
    8_192,
  )
}

function normalizeMcpResult(result: {
  content: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}): ToolResult {
  const content = normalizeContent(result.content)
  if (result.isError) {
    return {
      status: 'error',
      code: 'MCP_TOOL_ERROR',
      message: textFromContent(content) || 'MCP tool reported an error',
      retryable: false,
    }
  }
  return {
    status: 'ok',
    content: {
      ...(result.structuredContent
        ? { structuredContent: jsonValue(result.structuredContent) }
        : {}),
      content,
    },
  }
}

function normalizeContent(content: unknown[]): JsonValue[] {
  return content.map((entry) => {
    if (!entry || typeof entry !== 'object')
      return jsonValue({ type: 'unknown' })
    const type = Reflect.get(entry, 'type')
    if (type === 'text') {
      return jsonValue({
        type: 'text',
        text: String(Reflect.get(entry, 'text') ?? ''),
      })
    }
    if (type === 'resource') {
      const resource = Reflect.get(entry, 'resource')
      if (resource && typeof resource === 'object') {
        const text = Reflect.get(resource, 'text')
        return jsonValue({
          type: 'resource',
          uri: String(Reflect.get(resource, 'uri') ?? ''),
          ...(typeof text === 'string' ? { text } : { omitted: 'binary' }),
        })
      }
    }
    if (type === 'resource_link') {
      return jsonValue({
        type: 'resource_link',
        uri: String(Reflect.get(entry, 'uri') ?? ''),
        name: String(Reflect.get(entry, 'name') ?? ''),
      })
    }
    if (type === 'image' || type === 'audio') {
      return jsonValue({
        type: String(type),
        mimeType: String(Reflect.get(entry, 'mimeType') ?? ''),
        omitted: 'binary',
      })
    }
    return jsonValue({
      type: typeof type === 'string' ? type : 'unknown',
      omitted: true,
    })
  })
}

function textFromContent(content: JsonValue[]): string {
  return content
    .map((entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.text === 'string'
        ? entry.text
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .slice(0, 65_536)
}

function failureResult(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'MCP_FAILED',
    message: error instanceof Error ? error.message : 'MCP operation failed',
    retryable: false,
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
