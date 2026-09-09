import { Type, type Static } from '@sinclair/typebox'

export const EXEC_DEFAULT_YIELD_MS = 10_000
export const EXEC_MAX_YIELD_MS = 60_000
export const EXEC_MAX_INPUT_BYTES = 262_144

export const ExecCommandSchema = Type.Object(
  {
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          'Opaque exec session handle from this Run. Not a conversation or Terminal id.',
      }),
    ),
    command: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: EXEC_MAX_INPUT_BYTES,
        description:
          'Without sessionId, execute this complete script using the configured command_shell; no trailing newline is needed. With sessionId, send this text to the existing process stdin, appending LF only when a line ending is absent. This does not start another shell.',
      }),
    ),
    executable: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description:
          'Start this executable directly, without shell parsing. Mutually exclusive with command.',
      }),
    ),
    args: Type.Optional(
      Type.Array(Type.String({ maxLength: 65_536 }), {
        maxItems: 256,
        description:
          'Argument array for a new executable. Defaults to an empty array.',
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description:
          'Initial workspace-relative or absolute project-temp directory. Only accepted when starting a new process; defaults to the workspace root.',
      }),
    ),
    chars: Type.Optional(
      Type.String({
        maxLength: EXEC_MAX_INPUT_BYTES,
        description:
          'With sessionId, write these UTF-8 characters exactly as supplied. No newline or control-character conversion. Empty means poll. In a pipe, Ctrl+C is a byte, not a signal; use terminate to stop.',
      }),
    ),
    closeStdin: Type.Optional(
      Type.Boolean({
        description:
          'With sessionId, close stdin after any supplied input to send EOF. Does not stop the process.',
      }),
    ),
    terminate: Type.Optional(
      Type.Boolean({
        description:
          'With sessionId, stop this process tree and wait for cleanup. Do not combine with input or closeStdin.',
      }),
    ),
    yieldTimeMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: EXEC_MAX_YIELD_MS,
        description:
          'Wait up to this many milliseconds for completion. Defaults to 10000; 0 returns an immediate snapshot. The wait limit never kills the process.',
      }),
    ),
  },
  { additionalProperties: false },
)

export type ExecCommandArgs = Static<typeof ExecCommandSchema>
export type ExecCommandAction = 'start' | 'write' | 'read' | 'stop'

/** Classifies a schema-valid call consistently for scheduling, policy, and execution. */
export function execCommandAction(args: ExecCommandArgs): ExecCommandAction {
  if (args.sessionId === undefined) return 'start'
  if (args.terminate) return 'stop'
  if (args.command !== undefined || Boolean(args.chars) || args.closeStdin)
    return 'write'
  return 'read'
}

/** Rejects ambiguous launch, input, and control combinations before any side effect. */
export function validateExecCommandArgs(
  args: ExecCommandArgs,
): string | undefined {
  if (args.command !== undefined && args.chars !== undefined)
    return 'command and chars are mutually exclusive'
  if (args.sessionId === undefined) {
    if (
      args.chars !== undefined ||
      args.closeStdin !== undefined ||
      args.terminate !== undefined
    )
      return 'chars, closeStdin, and terminate require sessionId'
    if ((args.command !== undefined) === (args.executable !== undefined))
      return 'Provide exactly one of command or executable when starting a process'
    if (args.args !== undefined && args.executable === undefined)
      return 'args requires executable'
  } else {
    if (
      args.executable !== undefined ||
      args.args !== undefined ||
      args.cwd !== undefined
    )
      return 'executable, args, and cwd are only allowed when starting a process'
    if (
      args.terminate &&
      (args.command !== undefined ||
        args.chars !== undefined ||
        args.closeStdin !== undefined)
    )
      return 'terminate cannot be combined with input or closeStdin'
  }
  return undefined
}

/** Completes one stdin submission without applying PTY-specific newline conversion. */
export function execCommandInput(
  args: Pick<ExecCommandArgs, 'command' | 'chars'>,
): string {
  if (args.command === undefined) return args.chars ?? ''
  return /[\r\n]$/u.test(args.command) ? args.command : `${args.command}\n`
}
