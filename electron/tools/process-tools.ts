import { Type, type Static } from '@sinclair/typebox'
import { delay } from '../../shared/async/delay'
import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ToolRegistrationPort, ToolResult } from './types'
import { runCommand } from '../process/run'
import { sessionArtifactKey } from '../session-temp/service'
import {
  commandShellService,
  type CommandShellService,
} from '../process/command-shell'
import {
  projectDelayResult,
  projectRunCommandResult,
} from './tool-result-formatters'

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
          'Workspace-relative directory or absolute Session-temp directory. Omit to run from the workspace root.',
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
        'Milliseconds to wait before the next step. Prefer background_wait for Terminal or Agent tasks.',
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

/** Registers the bounded process-execution tool and its argument policy. */
export function registerProcessTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
  shells: Pick<
    CommandShellService,
    'resolve' | 'invocation'
  > = commandShellService,
): void {
  registry.registerTool({
    id: 'run_command',
    executionMode: 'parallel',
    description:
      'Run a bounded short-lived child process from the workspace or Session temp. Prefer process mode with an executable and argument array. Shell mode uses the configured command_shell reported in environment_context and is higher risk; do not assume another shell syntax. For long-running tests, watch tasks, dev servers, REPLs, or commands that need periodic observation, use a Terminal, background_wait, and its artifact log.',
    inputSchema: RunCommandSchema,
    effects: ['process.spawn'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 86_400_000,
    validateArgs: validateRunCommandArgs,
    projectResultForModel: projectRunCommandResult,
    async execute(args: RunCommandArgs, context): Promise<ToolResult> {
      const config = getConfig()
      const limits = config.limits
      const resolvedShell =
        args.mode === 'shell'
          ? await shells.resolve(config.executionEnvironment.commandShell)
          : undefined
      const invocation =
        args.mode === 'shell' && resolvedShell
          ? shells.invocation(resolvedShell, args.command!)
          : undefined
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
              executable: invocation!.executable,
              args: invocation!.args,
              environment: invocation!.environment,
              fallbackEncoding: resolvedShell!.fallbackEncoding,
              cwd: args.cwd,
            }
      const result = await runCommand({
        workspace: context.workspace.canonicalPath,
        command,
        timeoutMs: Math.min(
          args.timeoutMs ?? limits.commandTimeoutMs,
          limits.commandTimeoutMs,
        ),
        maxOutputBytes:
          context.toolOutputLimits?.maxToolOutputBytes ??
          limits.maxToolOutputBytes,
        sessionTemp: context.sessionTemp,
        artifactKey: sessionArtifactKey(
          `${context.runId}:${context.approvedCall.callId}`,
        ),
        signal: context.signal,
      })

      if (result.cancelled || context.signal.aborted) {
        return {
          status: 'cancelled',
          message: `The command was cancelled${artifactResultSuffix(result)}`,
        }
      }

      if (result.timedOut) {
        return {
          status: 'timeout',
          message: `Command timed out after ${Math.round(
            result.durationMs,
          )} ms${artifactResultSuffix(result)}`,
        }
      }

      return {
        status: 'ok',
        content: JSON.parse(
          JSON.stringify({
            ...result,
            ...(resolvedShell
              ? {
                  commandShell: {
                    id: resolvedShell.profile.id,
                    label: resolvedShell.profile.label,
                    fallback: resolvedShell.fallback,
                  },
                }
              : {}),
          }),
        ) as JsonValue,
        truncated: result.truncated,
        totalBytes: result.totalBytes,
      }
    },
  })

  registry.registerTool({
    id: 'delay',
    executionMode: 'parallel',
    description:
      'Wait for a short bounded interval. Prefer background_wait when waiting for Terminal or Agent task completion.',
    inputSchema: DelaySchema,
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: MAX_DELAY_MS + 5_000,
    projectResultForModel: projectDelayResult,
    async execute(args: DelayArgs, context): Promise<ToolResult> {
      const startedAt = performance.now()
      await delay(args.durationMs, context.signal)
      return {
        status: 'ok',
        content: {
          waitedMs: Math.round(performance.now() - startedAt),
        },
      }
    },
  })
}

function artifactResultSuffix(result: {
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
}): string {
  if (result.artifactPath) return `; artifactPath=${result.artifactPath}`
  return `; artifactAvailable=false${
    result.captureError ? `; captureError=${result.captureError}` : ''
  }`
}
