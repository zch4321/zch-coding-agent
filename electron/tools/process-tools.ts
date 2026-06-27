import { Type, type Static } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ToolRegistrationPort, ToolResult } from './types'
import { runCommand } from '../process/run'

const MAX_DELAY_MS = 60_000

const RunCommandSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('process'), Type.Literal('shell')], {
      description:
        "Use 'process' for executable + args, or 'shell' for a command string.",
    }),
    executable: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description: "Required when mode is 'process'.",
      }),
    ),
    args: Type.Optional(
      Type.Array(Type.String({ maxLength: 65_536 }), {
        maxItems: 256,
        description: "Arguments for executable when mode is 'process'.",
      }),
    ),
    command: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 262_144,
        description: "Required when mode is 'shell'.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'Workspace-relative working directory. Omit to run from the workspace root.',
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 100,
        maximum: 86_400_000,
        description:
          'Requested command timeout in milliseconds, capped by configured commandTimeoutMs.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Run a bounded short-lived process without shell parsing, or explicitly run a higher-risk shell command. Use terminal tools for long-running tests, watch tasks, dev servers, REPLs, and commands that need periodic observation.',
  },
)
type RunCommandArgs = Static<typeof RunCommandSchema>

const DelaySchema = Type.Object(
  {
    durationMs: Type.Integer({
      minimum: 1,
      maximum: MAX_DELAY_MS,
      description:
        'Milliseconds to wait before the next step. Use after terminal_send before terminal_read when observing long-running tests, dev servers, watch tasks, or REPL output.',
    }),
  },
  { additionalProperties: false },
)
type DelayArgs = Static<typeof DelaySchema>

function validateRunCommandArgs(args: RunCommandArgs): string | undefined {
  if (args.mode === 'process') {
    if (!args.executable) {
      return "run_command executable is required when mode is 'process'"
    }

    if (args.command !== undefined) {
      return "run_command command is only allowed when mode is 'shell'"
    }

    return undefined
  }

  if (!args.command) {
    return "run_command command is required when mode is 'shell'"
  }

  if (args.executable !== undefined || args.args !== undefined) {
    return "run_command executable and args are only allowed when mode is 'process'"
  }

  return undefined
}

function wait(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, durationMs)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('delay aborted'))
    }

    if (signal.aborted) {
      abort()
      return
    }

    signal.addEventListener('abort', abort, { once: true })
  })
}

export function registerProcessTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
): void {
  registry.registerTool({
    id: 'run_command',
    description:
      'Run a bounded short-lived child process from the workspace. Prefer process mode with an executable and argument array. Shell mode is higher risk. For long-running tests, watch tasks, dev servers, REPLs, or commands that need periodic observation, open a terminal, send the command, use delay, then read terminal output.',
    inputSchema: RunCommandSchema,
    effects: ['process.spawn'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 86_400_000,
    maxOutputBytes: 128 * 1_024,
    validateArgs: validateRunCommandArgs,
    async execute(args: RunCommandArgs, context): Promise<ToolResult> {
      const limits = getConfig().limits
      const command =
        args.mode === 'process'
          ? {
              mode: args.mode,
              executable: args.executable!,
              args: args.args,
              cwd: args.cwd,
            }
          : {
              mode: args.mode,
              command: args.command!,
              cwd: args.cwd,
            }
      const result = await runCommand({
        workspace: context.workspace.canonicalPath,
        command,
        timeoutMs: Math.min(
          args.timeoutMs ?? limits.commandTimeoutMs,
          limits.commandTimeoutMs,
        ),
        maxOutputBytes: Math.min(limits.maxToolOutputBytes, 64 * 1_024),
        signal: context.signal,
      })

      if (result.cancelled || context.signal.aborted) {
        return { status: 'cancelled', message: 'The command was cancelled' }
      }

      if (result.timedOut) {
        return {
          status: 'timeout',
          message: `Command timed out after ${Math.round(result.durationMs)} ms`,
        }
      }

      return {
        status: 'ok',
        content: JSON.parse(JSON.stringify(result)) as JsonValue,
        truncated: result.truncated,
        totalBytes: result.totalBytes,
      }
    },
  })

  registry.registerTool({
    id: 'delay',
    description:
      'Wait for a short bounded interval before continuing. Use with terminal_read polling after terminal_send for long-running tests, watch tasks, dev servers, or REPLs.',
    inputSchema: DelaySchema,
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: MAX_DELAY_MS + 5_000,
    maxOutputBytes: 4_096,
    async execute(args: DelayArgs, context): Promise<ToolResult> {
      const startedAt = performance.now()
      await wait(args.durationMs, context.signal)
      return {
        status: 'ok',
        content: {
          waitedMs: Math.round(performance.now() - startedAt),
        },
      }
    },
  })
}
