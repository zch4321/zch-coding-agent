import { Type } from '@sinclair/typebox'
import type { TerminalId } from '../../shared/ids'
import type { TerminalPool } from '../terminal/pool'
import type { ToolDefinition, ToolRegistrationPort } from './types'

const TerminalIdField = Type.Unsafe<TerminalId>(
  Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
    title: 'TerminalId',
    description:
      'Terminal id returned by terminal_open or terminal_list for this session.',
  }),
)

const OpenSchema = Type.Object(
  {
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative directory for the terminal. Omit for workspace root.',
      }),
    ),
    shell: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Optional shell executable. Omit to use the configured/default shell.',
      }),
    ),
    cols: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: 1_000,
        description: 'Initial terminal width in columns.',
      }),
    ),
    rows: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1_000,
        description: 'Initial terminal height in rows.',
      }),
    ),
  },
  { additionalProperties: false },
)
const SendSchema = Type.Object(
  {
    terminalId: TerminalIdField,
    data: Type.String({
      minLength: 1,
      maxLength: 262_144,
      description:
        'Input bytes to send to the terminal. Include a trailing newline to press Enter.',
    }),
  },
  { additionalProperties: false },
)
const ReadSchema = Type.Object(
  {
    terminalId: TerminalIdField,
    cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Optional scrollback cursor from a previous terminal_read result.',
      }),
    ),
    lines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 5_000,
        description: 'Maximum number of terminal lines to return.',
      }),
    ),
  },
  { additionalProperties: false },
)
const ListSchema = Type.Object({}, { additionalProperties: false })
const CloseSchema = Type.Object(
  {
    terminalId: TerminalIdField,
  },
  { additionalProperties: false },
)
const ResizeSchema = Type.Object(
  {
    terminalId: TerminalIdField,
    cols: Type.Integer({
      minimum: 2,
      maximum: 1_000,
      description: 'New terminal width in columns.',
    }),
    rows: Type.Integer({
      minimum: 1,
      maximum: 1_000,
      description: 'New terminal height in rows.',
    }),
  },
  { additionalProperties: false },
)

export function registerTerminalTools(
  registry: ToolRegistrationPort,
  terminalPool: TerminalPool,
  getMaxOutputBytes: () => number,
): void {
  registry.registerTool({
    id: 'terminal_open',
    description:
      'Open a persistent terminal owned by the current session. Use for long-running tests, watch tasks, dev servers, REPLs, and commands that need repeated observation.',
    inputSchema: OpenSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 65_536,
    async execute(args, context) {
      const terminal = await terminalPool.open({
        sessionId: context.sessionId,
        workspace: context.workspace.canonicalPath,
        ...args,
      })
      return { status: 'ok', content: { ...terminal } }
    },
  } satisfies ToolDefinition<typeof OpenSchema>)

  registry.registerTool({
    id: 'terminal_send',
    description:
      'Send input to a persistent terminal owned by this session. Include a newline to start a command. For long-running commands, follow with delay and terminal_read instead of run_command.',
    inputSchema: SendSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 16_384,
    async execute(args, context) {
      return {
        status: 'ok',
        content: {
          accepted: terminalPool.write(
            context.sessionId,
            args.terminalId,
            args.data,
          ),
        },
      }
    },
  } satisfies ToolDefinition<typeof SendSchema>)

  registry.registerTool({
    id: 'terminal_read',
    description:
      'Read bounded, ANSI-free output from a persistent terminal owned by this session. Use cursor for incremental polling after delay while a long-running test, server, watcher, or REPL continues.',
    inputSchema: ReadSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    async execute(args, context) {
      const result = terminalPool.read(context.sessionId, args.terminalId, {
        cursor: args.cursor,
        lines: args.lines,
        maxBytes: Math.min(getMaxOutputBytes(), 32 * 1_024),
      })
      return {
        status: 'ok',
        content: result,
        truncated: result.truncated,
        totalBytes: result.totalBytes,
      }
    },
  } satisfies ToolDefinition<typeof ReadSchema>)

  registry.registerTool({
    id: 'terminal_list',
    description: 'List persistent terminals owned by this session.',
    inputSchema: ListSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 65_536,
    async execute(_args, context) {
      return {
        status: 'ok',
        content: terminalPool.list(context.sessionId).map((terminal) => ({
          ...terminal,
        })),
      }
    },
  } satisfies ToolDefinition<typeof ListSchema>)

  registry.registerTool({
    id: 'terminal_close',
    description: 'Close a persistent terminal owned by this session.',
    inputSchema: CloseSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 16_384,
    async execute(args, context) {
      return {
        status: 'ok',
        content: {
          closed: terminalPool.close(context.sessionId, args.terminalId),
        },
      }
    },
  } satisfies ToolDefinition<typeof CloseSchema>)

  registry.registerTool({
    id: 'terminal_resize',
    description: 'Resize a persistent terminal owned by this session.',
    inputSchema: ResizeSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 16_384,
    async execute(args, context) {
      return {
        status: 'ok',
        content: {
          resized: terminalPool.resize(
            context.sessionId,
            args.terminalId,
            args.cols,
            args.rows,
          ),
        },
      }
    },
  } satisfies ToolDefinition<typeof ResizeSchema>)
}
