import { Type } from '@sinclair/typebox'
import type { TerminalId } from '../../shared/ids'
import type { TerminalPool } from '../terminal/pool'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'
import {
  projectTerminalOpenResult,
  projectTerminalSendResult,
} from './tool-result-formatters'

const MAX_TERMINAL_SEND_DELAY_MS = 60_000

const TerminalIdField = Type.Unsafe<TerminalId>(
  Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    title: 'TerminalId',
    description: 'Numeric Terminal id returned by terminal_open.',
  }),
)

const OpenSchema = Type.Object(
  {
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative directory or absolute Session-temp directory for the Terminal. Omit for workspace root.',
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
        minimum: 0,
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
      description: 'Input text or control sequence to submit to the terminal.',
    }),
    delayMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_TERMINAL_SEND_DELAY_MS,
        description:
          'Milliseconds to wait before returning new output. Defaults to 1000; set 0 for an immediate snapshot.',
      }),
    ),
  },
  { additionalProperties: false },
)
/** Registers Provider-visible Terminal launch and input tools. */
export function registerTerminalTools(
  registry: ToolRegistrationPort,
  terminalPool: TerminalPool,
): void {
  registry.registerTool({
    id: 'terminal_open',
    executionMode: 'serial',
    description:
      'Open a persistent terminal owned by the current session using the configured shell. This starts the shell process but does not submit a command. Use for long-running tests, watch tasks, dev servers, REPLs, and commands that need repeated observation.',
    inputSchema: OpenSchema,
    effects: ['process.spawn', 'terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 10_000,
    projectResultForModel: projectTerminalOpenResult,
    async execute(args, context) {
      const terminal = await terminalPool.open({
        sessionId: context.sessionId,
        ownerSessionId: context.ownerSessionId ?? context.sessionId,
        workspace: context.workspace.canonicalPath,
        sessionTemp: context.sessionTemp,
        ...args,
      })
      return {
        status: 'ok',
        content: {
          ...terminal,
          target: { type: 'terminal', id: terminal.terminalId },
        },
      }
    },
  } satisfies ToolDefinition<typeof OpenSchema>)

  registry.registerTool({
    id: 'terminal_send',
    executionMode: 'serial',
    description:
      'Submit input to a persistent Terminal. Input is newline-normalized, then the tool waits 1 second by default and returns new ANSI-free output; when no new output arrives it returns a short tail. Full output remains in the returned artifactPath.',
    inputSchema: SendSchema,
    effects: ['terminal.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: MAX_TERMINAL_SEND_DELAY_MS + 5_000,
    projectResultForModel: projectTerminalSendResult,
    async execute(args, context): Promise<ToolResult> {
      const before = terminalPool.modelCursor(
        context.sessionId,
        args.terminalId,
      )
      const accepted = terminalPool.write(
        context.sessionId,
        args.terminalId,
        normalizeTerminalInput(args.data),
      )
      if (!accepted) {
        const background = terminalPool.backgroundSnapshot(
          context.ownerSessionId ?? context.sessionId,
          args.terminalId,
        )
        return {
          status: 'ok',
          content: {
            accepted,
            content: '',
            cursor: background.cursor,
            delta: false,
            artifactAvailable: background.artifactAvailable,
            ...(background.artifactPath
              ? { artifactPath: background.artifactPath }
              : {}),
            ...(background.captureError
              ? { captureError: background.captureError }
              : {}),
          },
        }
      }
      const startedAt = performance.now()
      await waitForTerminalDelay(args.delayMs ?? 1_000, context.signal)
      const output = terminalPool.readDeltaOrTail(
        context.sessionId,
        args.terminalId,
        before,
        { lines: 20, maxBytes: 8 * 1_024 },
      )
      const background = terminalPool.backgroundSnapshot(
        context.ownerSessionId ?? context.sessionId,
        args.terminalId,
      )
      return {
        status: 'ok',
        content: {
          accepted,
          waitedMs: Math.round(performance.now() - startedAt),
          content: output.content,
          cursor: output.cursor,
          delta: output.delta,
          truncated: output.truncated,
          artifactAvailable: background.artifactAvailable,
          ...(background.artifactPath
            ? { artifactPath: background.artifactPath }
            : {}),
          ...(background.captureError
            ? { captureError: background.captureError }
            : {}),
        },
      }
    },
  } satisfies ToolDefinition<typeof SendSchema>)
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
