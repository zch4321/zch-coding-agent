import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_TASK_BYTES = 1_048_576

export interface HeadlessRunArguments {
  workspace: string
  taskFile: string
  configFile: string
  artifactsDirectory: string
  timeoutMs: number
}

/** Reports invalid headless runner arguments or input files. */
export class HeadlessCliError extends Error {
  readonly code = 'HEADLESS_CLI_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'HeadlessCliError'
  }
}

/** Parses headless run arguments into config, task, workspace, and output options. */
export function parseHeadlessArguments(argv: string[]): HeadlessRunArguments {
  if (argv[0] !== 'run') {
    throw new HeadlessCliError('Expected the run command')
  }

  const values = new Map<string, string>()
  const allowed = new Set([
    '--workspace',
    '--task-file',
    '--config',
    '--artifacts',
    '--timeout-ms',
  ])
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !allowed.has(flag)) {
      throw new HeadlessCliError(`Unknown argument: ${flag ?? ''}`)
    }
    if (values.has(flag)) {
      throw new HeadlessCliError(`Duplicate argument: ${flag}`)
    }
    if (!value || value.startsWith('--')) {
      throw new HeadlessCliError(`Missing value for ${flag}`)
    }
    values.set(flag, value)
  }

  const required = (flag: string): string => {
    const value = values.get(flag)
    if (!value) throw new HeadlessCliError(`Missing required argument: ${flag}`)
    return path.resolve(value)
  }
  const timeoutValue = values.get('--timeout-ms')
  if (!timeoutValue || !/^\d+$/u.test(timeoutValue)) {
    throw new HeadlessCliError('--timeout-ms must be a positive integer')
  }
  const timeoutMs = Number(timeoutValue)
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 86_400_000
  ) {
    throw new HeadlessCliError('--timeout-ms must be between 1 and 86400000')
  }
  return {
    workspace: required('--workspace'),
    taskFile: required('--task-file'),
    configFile: required('--config'),
    artifactsDirectory: required('--artifacts'),
    timeoutMs,
  }
}

/** Reads a bounded UTF-8 task text file for a headless run. */
export async function readHeadlessTask(filePath: string): Promise<string> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    throw new HeadlessCliError('Unable to read task file')
  }
  if (!fileStat.isFile()) throw new HeadlessCliError('Task path is not a file')
  if (fileStat.size > MAX_TASK_BYTES) {
    throw new HeadlessCliError('Task file exceeds 1 MiB')
  }
  const task = (await readFile(filePath, 'utf8')).trim()
  if (!task) throw new HeadlessCliError('Task file is empty')
  return task
}
