import { Type, type Static } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ToolRegistrationPort, ToolResult } from './types'
import { runCommand } from '../process/run'

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
      'Run a process without shell parsing, or explicitly run a higher-risk shell command.',
  },
)
type RunCommandArgs = Static<typeof RunCommandSchema>

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

export function registerProcessTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
): void {
  registry.registerTool({
    id: 'run_command',
    description:
      'Run a bounded child process from the workspace. Prefer process mode with an executable and argument array. Shell mode is higher risk.',
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
}
