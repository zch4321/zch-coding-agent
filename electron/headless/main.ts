#!/usr/bin/env node
import path from 'node:path'
import type { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  HeadlessCliError,
  parseHeadlessArguments,
  readHeadlessTask,
} from './cli'
import { HeadlessConfigError, loadHeadlessConfig } from './config'
import type { HeadlessRunStatus } from './contracts'
import {
  HeadlessRunInputError,
  runHeadlessAgent,
  type RunHeadlessAgentOptions,
} from './runner'

export const HEADLESS_EXIT_CODES = {
  completed: 0,
  failed: 2,
  timed_out: 3,
  invalid_input: 4,
  needs_human_input: 5,
  cancelled: 130,
} as const

export interface HeadlessMainOptions {
  output?: Writable
  errorOutput?: Writable
  environment?: NodeJS.ProcessEnv
  providerFactory?: RunHeadlessAgentOptions['providerFactory']
  promptDirectory?: string
  manageSignals?: boolean
}

export async function runHeadlessMain(
  argv: string[],
  options: HeadlessMainOptions = {},
): Promise<number> {
  const controller = new AbortController()
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const abort = () =>
    controller.abort(new Error('Headless process interrupted'))
  if (options.manageSignals !== false) {
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
  }

  try {
    const args = parseHeadlessArguments(argv)
    const [config, task] = await Promise.all([
      loadHeadlessConfig(args.configFile),
      readHeadlessTask(args.taskFile),
    ])
    const result = await runHeadlessAgent({
      config,
      workspace: args.workspace,
      task,
      artifactsDirectory: args.artifactsDirectory,
      timeoutMs: args.timeoutMs,
      output,
      signal: controller.signal,
      environment: options.environment,
      providerFactory: options.providerFactory,
      promptDirectory: options.promptDirectory,
      onDiagnostic: (message, error) => {
        errorOutput.write(
          `[headless] ${message}${error instanceof Error ? `: ${error.message}` : ''}\n`,
        )
      },
    })
    return exitCodeForStatus(result.status)
  } catch (error) {
    const knownInputError =
      error instanceof HeadlessCliError ||
      error instanceof HeadlessConfigError ||
      error instanceof HeadlessRunInputError
    errorOutput.write(
      `[headless] ${error instanceof Error ? error.message : 'Unexpected failure'}\n`,
    )
    return knownInputError
      ? HEADLESS_EXIT_CODES.invalid_input
      : HEADLESS_EXIT_CODES.failed
  } finally {
    if (options.manageSignals !== false) {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
  }
}

function exitCodeForStatus(status: HeadlessRunStatus): number {
  return HEADLESS_EXIT_CODES[status]
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  void runHeadlessMain(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
