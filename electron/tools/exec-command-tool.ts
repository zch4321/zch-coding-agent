import type { PublicConfig } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import { CommandSessionManager } from '../process/command-sessions'
import {
  commandShellService,
  type CommandShellService,
} from '../process/command-shell'
import { sessionArtifactKey } from '../session-temp/service'
import type { ToolDefinition, ToolRegistrationPort } from './types'
import {
  EXEC_DEFAULT_YIELD_MS,
  EXEC_MAX_YIELD_MS,
  ExecCommandSchema,
  execCommandAction,
  execCommandInput,
  validateExecCommandArgs,
} from './exec-command-schema'
import { formatExecCommandResult } from './exec-command-result'
import { clampToolWaitTime } from '../tooling/input-normalizer'

/** Registers one Run-scoped tool for pipe process launch, stdin, output, and cancellation. */
export function registerExecCommandTool(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
  sessions: CommandSessionManager,
  shells: Pick<
    CommandShellService,
    'resolve' | 'invocation'
  > = commandShellService,
): void {
  registry.registerTool({
    id: 'exec_command',
    description:
      'Execute a command within the current Run using pipes (no TTY). Use command for the configured command_shell, or executable + args for direct execution. Wait defaults to 10 seconds, at most 60; yielding returns sessionId without killing the process. Follow up with sessionId to read new output, with command to send input plus a missing newline, or with chars for exact stdin bytes. With sessionId, command is input to the existing process, not a new shell command. Use closeStdin for EOF and terminate to stop. artifactPath is a directory: read stdout.log or stderr.log inside it for full captured output; result.json is written after the process exits and capture finishes. All remaining exec processes are stopped when this Run finishes or is cancelled. Wait for required results before giving the final answer. Use Terminal for TTY or work that must survive the Run.',
    inputSchema: ExecCommandSchema,
    normalizeArgs: (args) =>
      clampToolWaitTime(args, 'yieldTimeMs', EXEC_MAX_YIELD_MS),
    executionMode: 'parallel',
    effects: ['process.spawn'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: null,
    modelOutputPolicy: 'paged',
    validateArgs: validateExecCommandArgs,
    resolveTraits(args) {
      switch (execCommandAction(args)) {
        case 'start':
          return {
            executionMode: 'parallel',
            effects: ['process.spawn'],
            defaultRisk: 'review',
          }
        case 'write':
          return {
            executionMode: 'serial',
            effects: ['process.write'],
            defaultRisk: 'review',
            allowRememberedApproval: false,
          }
        case 'read':
        case 'stop':
          return {
            executionMode: 'parallel',
            effects: [],
            defaultRisk: 'low',
            allowRememberedApproval: false,
          }
      }
    },
    policyContext(args, owner) {
      if (!args.sessionId) return []
      const launch = sessions.describe(owner, args.sessionId)
      return execCommandAction(args) === 'write'
        ? [
            {
              code: 'exec_stdin_write',
              severity: 'warning',
              detail: `Write stdin/EOF to existing process: ${JSON.stringify(launch).slice(0, 4096)}`,
            },
          ]
        : []
    },
    projectResultForModel(result) {
      const content = result.content as Record<string, JsonValue>
      return [{ type: 'text', text: String(content.modelText ?? '') }]
    },
    async execute(args, context) {
      const owner = { sessionId: context.sessionId, runId: context.runId }
      const config = getConfig()
      const limits = context.toolOutputLimits ?? config.limits
      let sessionId = args.sessionId
      if (!sessionId) {
        const shell =
          args.command !== undefined
            ? await shells.resolve(config.executionEnvironment.commandShell)
            : undefined
        const invocation = shell
          ? shells.invocation(shell, args.command!)
          : undefined
        sessionId = await sessions.start(owner, {
          workspace: context.workspace.canonicalPath,
          command:
            invocation && shell
              ? {
                  mode: 'shell',
                  executable: invocation.executable,
                  args: invocation.args,
                  environment: invocation.environment,
                  fallbackEncoding: shell.fallbackEncoding,
                  cwd: args.cwd,
                }
              : {
                  mode: 'process',
                  executable: args.executable!,
                  args: args.args,
                  cwd: args.cwd,
                },
          sessionTemp: context.sessionTemp,
          artifactKey: sessionArtifactKey(
            `${context.runId}:${context.approvedCall.callId}`,
          ),
          maxOutputBytes: limits.maxToolOutputBytes,
          launch:
            args.command !== undefined
              ? { command: args.command, cwd: args.cwd }
              : {
                  executable: args.executable,
                  args: args.args ?? [],
                  cwd: args.cwd,
                },
        })
      } else if (execCommandAction(args) === 'stop')
        sessions.terminate(owner, sessionId)
      else if (execCommandAction(args) === 'write')
        sessions.write(
          owner,
          sessionId,
          execCommandInput(args),
          args.closeStdin,
        )
      const snapshot = await sessions.read(
        owner,
        sessionId,
        args.yieldTimeMs ?? EXEC_DEFAULT_YIELD_MS,
        context.signal,
      )
      const rendered = formatExecCommandResult(snapshot, limits)
      return {
        status: 'ok',
        content: JSON.parse(
          JSON.stringify({
            ...snapshot,
            truncated: rendered.truncated,
            modelText: rendered.text,
          }),
        ) as JsonValue,
        truncated: rendered.truncated,
        totalBytes: snapshot.totalBytes,
      }
    },
  } satisfies ToolDefinition<typeof ExecCommandSchema>)
}
