import type { CommandSpec } from '../process/run'

const COMMON_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.pager=',
  '-c',
  'color.ui=never',
]
const INTERNAL_DIFF_ARGS = ['--no-ext-diff', '--no-textconv']

/** Builds a shell-free Git command with common display and external-diff restrictions. */
export function createGitCommand(
  args: readonly string[],
): Extract<CommandSpec, { mode: 'process' }> {
  const subcommand = args[0]
  const guardedArgs =
    subcommand === 'diff' || subcommand === 'show'
      ? [subcommand, ...INTERNAL_DIFF_ARGS, ...args.slice(1)]
      : args
  return {
    mode: 'process',
    executable: 'git',
    args: [...COMMON_ARGS, ...guardedArgs],
  }
}
