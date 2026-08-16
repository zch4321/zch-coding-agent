import { Type } from '@sinclair/typebox'
import type { TerminalId } from '../../shared/ids'
import type { TerminalPool } from '../terminal/pool'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'
import {
  projectTerminalCloseResult,
  projectTerminalOpenResult,
  projectTerminalReadResult,
  projectTerminalSendResult,
} from './tool-result-formatters'

const MAX_TERMINAL_SEND_DELAY_MS = 60_000

const TerminalIdField = Type.Unsafe<TerminalId>(
  Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
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
        'Input text or control sequence to submit to the terminal.',
    }),
    delayMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TERMINAL_SEND_DELAY_MS,
        description:
          'Optional milliseconds to wait after the input is accepted. Use before a sequential terminal_read when the command needs time to produce output.',
      }),
    ),
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

/** Registers Session terminal open, list, input, and close tools. */
export function registerTerminalTools(
  registry: ToolRegistrationPort,
  terminalPool: TerminalPool,
  getMaxOutputBytes: () => number,
): void {
  registry.registerTool({
    id: 'terminal_open',
    executionMode: 'serial',
    description:
      'Open a persistent terminal owned by the current session. Use for long-running tests, watch tasks, dev servers, REPLs, and commands that need repeated observation.',
    inputSchema: OpenSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 65_536,
    projectResultForModel: projectTerminalOpenResult,
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
    executionMode: 'serial',
    description:
      'Submit input to a persistent terminal owned by this session. The tool presses Enter automatically when needed. Optional delayMs waits after accepted input before returning so a sequential terminal_read can observe command output.',
    inputSchema: SendSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: MAX_TERMINAL_SEND_DELAY_MS + 5_000,
    maxOutputBytes: 16_384,
    projectResultForModel: projectTerminalSendResult,
    async execute(args, context): Promise<ToolResult> {
      const accepted = terminalPool.write(
        context.sessionId,
        args.terminalId,
        normalizeTerminalInput(args.data),
      )
      if (!accepted || args.delayMs === undefined) {
        return {
          status: 'ok',
          content: { accepted },
        }
      }
      const startedAt = performance.now()
      await waitForTerminalDelay(args.delayMs, context.signal)
      return {
        status: 'ok',
        content: {
          accepted,
          waitedMs: Math.round(performance.now() - startedAt),
        },
      }
    },
  } satisfies ToolDefinition<typeof SendSchema>)

  registry.registerTool({
    id: 'terminal_read',
    executionMode: 'serial',
    description:
      'Read bounded, ANSI-free output from a persistent terminal owned by this session. Use cursor for incremental polling after delay while a long-running test, server, watcher, or REPL continues.',
    inputSchema: ReadSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 64 * 1_024,
    projectResultForModel: projectTerminalReadResult,
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
    executionMode: 'serial',
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
    executionMode: 'serial',
    description: 'Close a persistent terminal owned by this session.',
    inputSchema: CloseSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 16_384,
    projectResultForModel: projectTerminalCloseResult,
    async execute(args, context) {
      return {
        status: 'ok',
        content: {
          closed: terminalPool.close(context.sessionId, args.terminalId),
        },
      }
    },
  } satisfies ToolDefinition<typeof CloseSchema>)
}

/** Waits after a successful terminal write while honoring run cancellation. */
function waitForTerminalDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, durationMs)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('terminal send delay aborted'))
    }

    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Terminates one submitted input and normalizes Enter for the platform PTY. */
export function normalizeTerminalInput(
  data: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const terminated = /[\r\n]$/u.test(data) ? data : `${data}\n`
  return platform === 'win32'
    ? terminated.replace(/(?<!\r)\n/gu, '\r')
    : terminated
}
