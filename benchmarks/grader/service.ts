import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  compileSchema,
  formatSchemaErrors,
} from '../../electron/schema-validator'
import { sha256Bytes } from '../cases/hash'
import { runBenchmarkCommand } from '../cases/process'
import {
  ISOLATED_GRADER_REVISION,
  IsolatedGraderInputSchema,
  type GraderCommandOutcome,
  type IsolatedGraderInput,
  type IsolatedGraderOutput,
} from './contracts'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const validateInput = compileSchema(IsolatedGraderInputSchema)

/** Runs the standalone grader service for the input artifact and writes its serialized result. */
export async function runGraderService(
  argv = process.argv.slice(2),
): Promise<void> {
  const paths = parseArguments(argv)
  const raw = await readFile(paths.input)
  if (raw.byteLength > MAX_INPUT_BYTES)
    throw new Error('Grader input exceeds 8 MiB')
  const inputSha256 = sha256Bytes(raw)
  let candidate: unknown
  try {
    candidate = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('Grader input is not valid JSON')
  }
  if (!validateInput(candidate)) {
    throw new Error(formatSchemaErrors(validateInput.errors))
  }
  const input = structuredClone(candidate) as IsolatedGraderInput
  const startedAt = new Date()
  const startedMs = performance.now()
  const commands: GraderCommandOutcome[] = []
  let status: IsolatedGraderOutput['status'] = 'completed'
  let error: IsolatedGraderOutput['error']
  try {
    for (let index = 0; index < input.setup.length; index += 1) {
      const outcome = await executeCommand({
        stage: 'setup',
        id: `setup-${index + 1}`,
        command: input.setup[index]!,
        workspace: paths.workspace,
      })
      commands.push(outcome)
      if (!outcome.passed) break
    }
    if (
      commands
        .filter((outcome) => outcome.stage === 'setup')
        .every((outcome) => outcome.passed)
    ) {
      for (const check of input.publicChecks) {
        commands.push(
          await executeCommand({
            stage: 'public',
            id: check.id,
            acceptanceGroupId: check.acceptanceGroupId,
            command: check.command,
            workspace: paths.workspace,
          }),
        )
      }
      for (const check of input.privateChecks) {
        commands.push(
          await executeCommand({
            stage: 'private',
            id: check.id,
            acceptanceGroupId: check.acceptanceGroupId,
            command: check.command,
            workspace: paths.workspace,
          }),
        )
      }
    }
  } catch {
    status = 'failed'
    error = {
      code: 'GRADER_SERVICE_FAILED',
      message: 'The isolated grader could not complete its command plan',
    }
  }
  const output: IsolatedGraderOutput = {
    schemaVersion: 1,
    graderRevision: ISOLATED_GRADER_REVISION,
    status,
    inputSha256,
    caseId: input.caseIdentity.caseId,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - startedMs),
    commands,
    error,
  }
  const temporary = `${paths.output}.tmp`
  await writeFile(temporary, `${JSON.stringify(output)}\n`, { mode: 0o644 })
  await rename(temporary, paths.output)
}

async function executeCommand(input: {
  stage: GraderCommandOutcome['stage']
  id: string
  acceptanceGroupId?: string
  command: IsolatedGraderInput['setup'][number]
  workspace: string
}): Promise<GraderCommandOutcome> {
  const started = performance.now()
  try {
    const result = await runBenchmarkCommand({
      command: input.command,
      workspace: input.workspace,
    })
    const passed = result.exitCode === 0 && !result.timedOut
    return {
      stage: input.stage,
      id: input.id,
      acceptanceGroupId: input.acceptanceGroupId,
      passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Math.max(0, performance.now() - started),
      stdoutSha256: sha256Bytes(result.stdout),
      stderrSha256: sha256Bytes(result.stderr),
      failureCategory: passed
        ? 'none'
        : result.timedOut
          ? 'timed_out'
          : 'exit_nonzero',
    }
  } catch {
    return {
      stage: input.stage,
      id: input.id,
      acceptanceGroupId: input.acceptanceGroupId,
      passed: false,
      exitCode: -1,
      timedOut: false,
      durationMs: Math.max(0, performance.now() - started),
      stdoutSha256: sha256Bytes(''),
      stderrSha256: sha256Bytes(''),
      failureCategory: 'execution_error',
    }
  }
}

function parseArguments(argv: string[]): {
  workspace: string
  input: string
  output: string
} {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !flag ||
      !['--workspace', '--input', '--output'].includes(flag) ||
      !value
    ) {
      throw new Error('Invalid isolated grader arguments')
    }
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (!value) throw new Error(`Missing grader argument: ${flag}`)
    return path.resolve(value)
  }
  return {
    workspace: required('--workspace'),
    input: required('--input'),
    output: required('--output'),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runGraderService().catch((error) => {
    process.stderr.write(
      `[isolated-grader] ${error instanceof Error ? error.message : 'failed'}\n`,
    )
    process.exitCode = 1
  })
}
