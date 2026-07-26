import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import { compileSchema } from '../../electron/schema-validator'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import { sha256Bytes } from '../cases/hash'
import { loadPrivateCaseSpec } from '../cases/loader'
import { prepareBenchmarkWorkspace } from '../cases/prepare'
import { runGit } from '../cases/process'
import {
  inspectDockerCapability,
  inspectWorkerImage,
  DockerWorkerUnsupportedError,
} from '../worker/capabilities'
import { DockerCommandError, runDockerCommand } from '../worker/docker-client'
import {
  directoryBytes,
  removePrivateDirectory,
  writePrivateFile,
} from '../worker/files'
import {
  ISOLATED_GRADER_REVISION,
  IsolatedGraderOutputSchema,
  type IsolatedGraderInput,
  type IsolatedGraderOutput,
  type IsolatedGraderRunResult,
} from './contracts'

const CONTAINER_WORKSPACE = '/workspace'
const CONTAINER_INPUT = '/grader/input'
const CONTAINER_OUTPUT = '/grader/output'
const MAX_GRADER_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_GRADER_LOG_BYTES = 1024 * 1024
const validateOutput = compileSchema(IsolatedGraderOutputSchema)

export interface RunIsolatedGraderInput {
  loadedCase: LoadedBenchmarkCase
  patch: string
  image: string
  expectedImageDigest: string
  expectedSourceCommit?: string
  artifactsDirectory: string
  signal?: AbortSignal
}

export type IsolatedGraderRunner = (
  input: RunIsolatedGraderInput,
) => Promise<IsolatedGraderRunResult>

/** Runs a benchmark grader in an isolated process and captures its bounded result and timing. */
export async function runIsolatedGrader(
  input: RunIsolatedGraderInput,
): Promise<IsolatedGraderRunResult> {
  const startedAt = new Date()
  const startedMs = performance.now()
  const containerName = `zch-grader-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const patchSha256 = sha256Bytes(input.patch)
  await mkdir(input.artifactsDirectory, { recursive: true })
  const stdoutPath = path.resolve(input.artifactsDirectory, 'stdout.log')
  const stderrPath = path.resolve(input.artifactsDirectory, 'stderr.log')
  const coordinatorResultPath = path.resolve(
    input.artifactsDirectory,
    'coordinator-result.restricted.json',
  )
  const result: IsolatedGraderRunResult = {
    schemaVersion: 1,
    status: 'invalid',
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: input.expectedImageDigest,
    inputSha256: sha256Bytes(''),
    startedAt: startedAt.toISOString(),
    completedAt: startedAt.toISOString(),
    durationMs: 0,
    patch: {
      sha256: patchSha256,
      present: Buffer.byteLength(input.patch) > 0,
      applies: false,
      scopeCompliant: false,
      hygienePassed: false,
    },
    sandbox: {
      networkDisabled: false,
      readOnlyRoot: false,
      nonRoot: false,
      capabilitiesDropped: false,
      noNewPrivileges: false,
      boundedResources: false,
      privateInputReadOnly: false,
      dockerSocketAbsent: false,
    },
    inputImmutable: false,
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: path.resolve(input.artifactsDirectory),
      stdoutPath,
      stderrPath,
      coordinatorResultPath,
    },
  }
  let privateDirectory: string | undefined
  let containerCreated = false
  try {
    if (input.signal?.aborted) throw new Error('Isolated grader was cancelled')
    privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'zch-grader-run-'))
    await chmod(privateDirectory, 0o700)
    const workspace = path.join(privateDirectory, 'workspace')
    const inputDirectory = path.join(privateDirectory, 'input')
    const outputDirectory = path.join(privateDirectory, 'output')
    await Promise.all([
      mkdir(inputDirectory, { mode: 0o755 }),
      mkdir(outputDirectory, { mode: 0o777 }),
    ])
    await chmod(outputDirectory, 0o777)
    await prepareBenchmarkWorkspace({
      loadedCase: input.loadedCase,
      destination: workspace,
    })
    const preflight = await preflightPatch({
      loadedCase: input.loadedCase,
      workspace,
      patch: input.patch,
    })
    result.patch.applies = preflight.applies
    result.patch.scopeCompliant = preflight.scopeCompliant
    result.patch.hygienePassed = preflight.hygienePassed
    if (
      !preflight.applies ||
      !preflight.scopeCompliant ||
      !preflight.hygienePassed
    ) {
      result.status = 'attempted'
      result.error = {
        code: preflight.code,
        message: 'The submitted patch failed a deterministic hard gate',
      }
      return result
    }

    const privateSpec = await loadPrivateCaseSpec(input.loadedCase)
    const graderInput = buildGraderInput(
      input.loadedCase,
      privateSpec.checks,
      patchSha256,
    )
    const graderInputRaw = `${JSON.stringify(graderInput)}\n`
    const inputSha256 = sha256Bytes(graderInputRaw)
    result.inputSha256 = inputSha256
    const graderInputPath = path.join(inputDirectory, 'grader-input.json')
    await writePrivateFile(graderInputPath, graderInputRaw)
    await makeWorkspaceWritable(workspace)

    const [capability, image] = await Promise.all([
      inspectDockerCapability(),
      inspectWorkerImage(input.image, input.expectedSourceCommit),
    ])
    if (image.digest !== input.expectedImageDigest) {
      throw new Error('Grader image digest does not match the trial identity')
    }
    result.graderImageDigest = image.digest
    const limits = input.loadedCase.manifest.resources
    const create = [
      'create',
      '--name',
      containerName,
      '--init',
      '--read-only',
      '--user',
      '10001:10001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(limits.pids),
      '--memory',
      String(limits.memoryBytes),
      '--cpus',
      String(limits.cpus),
      '--network',
      'none',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777',
      '--mount',
      mount(workspace, CONTAINER_WORKSPACE),
      '--mount',
      mount(inputDirectory, CONTAINER_INPUT, true),
      '--mount',
      mount(outputDirectory, CONTAINER_OUTPUT),
      input.image,
      'grader',
      '--workspace',
      CONTAINER_WORKSPACE,
      '--input',
      `${CONTAINER_INPUT}/grader-input.json`,
      '--output',
      `${CONTAINER_OUTPUT}/grader-output.json`,
    ]
    await runDockerCommand(create)
    containerCreated = true
    result.cleanup.containerRemoved = false
    result.sandbox = {
      networkDisabled: true,
      readOnlyRoot: true,
      nonRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      boundedResources:
        capability.operatingSystem === 'linux' &&
        capability.architecture === 'amd64',
      privateInputReadOnly: true,
      dockerSocketAbsent: true,
    }
    await runDockerCommand(['start', containerName])
    const waitPromise = runDockerCommand(['wait', containerName], {
      timeoutMs: Math.min(limits.wallTimeMs, 300_000) + 10_000,
      allowFailure: true,
    })
    const monitorController = new AbortController()
    const stop = await Promise.race([
      waitPromise.then(() => undefined),
      waitForGraderStop({
        signal: input.signal,
        disposeSignal: monitorController.signal,
        diskBytes: limits.diskBytes,
        directories: [workspace, inputDirectory, outputDirectory],
      }),
    ])
    monitorController.abort()
    if (stop) {
      await terminateContainer(containerName)
      await waitPromise.catch(() => undefined)
      throw new Error(stop)
    }
    const waited = await waitPromise
    await collectLogs(containerName, stdoutPath, stderrPath)
    const exitCode = Number.parseInt(waited.stdout.trim(), 10)
    if (exitCode !== 0) {
      throw new Error('Isolated grader container exited unsuccessfully')
    }
    const outputPath = path.join(outputDirectory, 'grader-output.json')
    const outputRaw = await readFile(outputPath)
    if (outputRaw.byteLength > MAX_GRADER_OUTPUT_BYTES) {
      throw new Error('Isolated grader output exceeds 4 MiB')
    }
    const candidate: unknown = JSON.parse(outputRaw.toString('utf8'))
    if (!validateOutput(candidate)) {
      throw new Error('Isolated grader output failed schema validation')
    }
    const output = candidate as IsolatedGraderOutput
    if (
      output.inputSha256 !== inputSha256 ||
      output.caseId !== input.loadedCase.manifest.id ||
      output.graderRevision !== ISOLATED_GRADER_REVISION
    ) {
      throw new Error('Isolated grader output identity mismatch')
    }
    validateOutputPlan(output, graderInput)
    result.inputImmutable =
      sha256Bytes(await readFile(graderInputPath)) === inputSha256
    if (!result.inputImmutable) {
      throw new Error('Isolated grader input changed during execution')
    }
    const rawReportPath = path.resolve(
      input.artifactsDirectory,
      'raw-report.restricted.json',
    )
    await writeFile(rawReportPath, outputRaw, { mode: 0o600 })
    result.artifacts.rawReportPath = rawReportPath
    result.output = structuredClone(output)
    result.status = output.status === 'completed' ? 'completed' : 'invalid'
    if (output.status !== 'completed') result.error = output.error
  } catch (error) {
    result.status =
      error instanceof DockerWorkerUnsupportedError ? 'unsupported' : 'invalid'
    result.error = {
      code:
        error instanceof DockerWorkerUnsupportedError
          ? error.code
          : error instanceof DockerCommandError
            ? error.code
            : 'ISOLATED_GRADER_FAILED',
      message: safeMessage(error),
    }
  } finally {
    if (containerCreated) {
      await terminateContainer(containerName)
      result.cleanup.containerRemoved = await removeContainer(containerName)
    }
    if (privateDirectory) {
      result.cleanup.privateDirectoryRemoved =
        await removePrivateDirectory(privateDirectory)
    }
    if (
      !result.cleanup.containerRemoved ||
      !result.cleanup.privateDirectoryRemoved
    ) {
      result.status = 'invalid'
      result.error = {
        code: 'ISOLATED_GRADER_CLEANUP_INCOMPLETE',
        message: 'Isolated grader cleanup did not remove every run resource',
      }
    }
    result.completedAt = new Date().toISOString()
    result.durationMs = Math.max(0, performance.now() - startedMs)
    await writeJsonAtomic(coordinatorResultPath, result)
    await chmod(coordinatorResultPath, 0o600)
  }
  return result
}

function buildGraderInput(
  loadedCase: LoadedBenchmarkCase,
  privateChecks: Awaited<ReturnType<typeof loadPrivateCaseSpec>>['checks'],
  patchSha256: string,
): IsolatedGraderInput {
  const manifest = loadedCase.manifest
  return {
    schemaVersion: 1,
    graderRevision: ISOLATED_GRADER_REVISION,
    caseIdentity: {
      caseId: manifest.id,
      suiteId: manifest.suite.id,
      suiteRevision: manifest.suite.revision,
      manifestSha256: loadedCase.identity.manifestSha256,
      privateSpecSha256: loadedCase.identity.privateSpecSha256,
      patchSha256,
    },
    setup: structuredClone(manifest.setup),
    publicChecks: manifest.publicChecks.map((check) => ({
      id: check.id,
      title: check.title,
      acceptanceGroupId: check.acceptanceGroupId,
      command: structuredClone(check.command),
    })),
    privateChecks: structuredClone(privateChecks),
    acceptanceGroups: structuredClone(manifest.acceptanceGroups),
  }
}

function validateOutputPlan(
  output: IsolatedGraderOutput,
  input: IsolatedGraderInput,
): void {
  const expected = [
    ...input.setup.map((_, index) => `setup:setup-${index + 1}:`),
    ...input.publicChecks.map(
      (check) => `public:${check.id}:${check.acceptanceGroupId}`,
    ),
    ...input.privateChecks.map(
      (check) => `private:${check.id}:${check.acceptanceGroupId}`,
    ),
  ]
  const actual = output.commands.map(
    (outcome) =>
      `${outcome.stage}:${outcome.id}:${outcome.acceptanceGroupId ?? ''}`,
  )
  const setupFailed = output.commands.some(
    (outcome) => outcome.stage === 'setup' && !outcome.passed,
  )
  const expectedPrefix = setupFailed
    ? expected.slice(0, actual.length)
    : expected
  if (JSON.stringify(actual) !== JSON.stringify(expectedPrefix)) {
    throw new Error('Isolated grader output command plan mismatch')
  }
}

async function preflightPatch(input: {
  loadedCase: LoadedBenchmarkCase
  workspace: string
  patch: string
}): Promise<{
  applies: boolean
  scopeCompliant: boolean
  hygienePassed: boolean
  code: string
}> {
  if (input.patch) {
    const applied = await runGit({
      workspace: input.workspace,
      args: ['apply', '--recount', '--whitespace=nowarn', '-'],
      stdin: input.patch,
      allowFailure: true,
    })
    if (applied.exitCode !== 0) {
      return {
        applies: false,
        scopeCompliant: false,
        hygienePassed: false,
        code: 'GRADER_PATCH_INVALID',
      }
    }
  }
  const scope = input.loadedCase.manifest.modificationScope
  const names = await runGit({
    workspace: input.workspace,
    args: ['diff', '--name-only', '--no-renames', 'HEAD'],
  })
  const files = names.stdout.trim().split(/\r?\n/u).filter(Boolean)
  const scopeCompliant =
    files.length <= scope.maxChangedFiles &&
    files.every(
      (file) =>
        scope.allowedPaths.some((pattern) => matchesScope(pattern, file)) &&
        !scope.deniedPaths.some((pattern) => matchesScope(pattern, file)),
    )
  const diff = await runGit({
    workspace: input.workspace,
    args: ['diff', '--binary', '--no-ext-diff', 'HEAD'],
    maxOutputBytes: scope.maxPatchBytes + 1,
    allowFailure: true,
  })
  const hygiene = await runGit({
    workspace: input.workspace,
    args: ['diff', '--check', 'HEAD'],
    allowFailure: true,
  })
  const hygienePassed =
    diff.exitCode === 0 &&
    Buffer.byteLength(diff.stdout) <= scope.maxPatchBytes &&
    hygiene.exitCode === 0
  return {
    applies: true,
    scopeCompliant,
    hygienePassed,
    code: !scopeCompliant
      ? 'GRADER_SCOPE_VIOLATION'
      : 'GRADER_PATCH_HYGIENE_FAILED',
  }
}

function matchesScope(pattern: string, file: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/')
  const normalizedFile = file.replaceAll('\\', '/')
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3)
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`)
  }
  return normalizedPattern === normalizedFile
}

async function makeWorkspaceWritable(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    await chmod(current, 0o777)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink())
        throw new Error('Grader workspace contains a symlink')
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) {
        const mode = (await stat(entryPath)).mode
        await chmod(entryPath, mode & 0o111 ? 0o777 : 0o666)
      }
    }
  }
}

async function collectLogs(
  container: string,
  stdoutPath: string,
  stderrPath: string,
): Promise<void> {
  const logs = await runDockerCommand(['logs', container], {
    allowFailure: true,
    maxOutputBytes: MAX_GRADER_LOG_BYTES * 2,
  })
  await Promise.all([
    writeFile(
      stdoutPath,
      Buffer.from(logs.stdout).subarray(-MAX_GRADER_LOG_BYTES),
      { mode: 0o600 },
    ),
    writeFile(
      stderrPath,
      Buffer.from(logs.stderr).subarray(-MAX_GRADER_LOG_BYTES),
      { mode: 0o600 },
    ),
  ])
}

async function waitForGraderStop(input: {
  signal?: AbortSignal
  disposeSignal: AbortSignal
  diskBytes: number
  directories: string[]
}): Promise<string> {
  return await new Promise((resolve) => {
    let settled = false
    const dispose = (): void => {
      clearInterval(diskTimer)
      input.signal?.removeEventListener('abort', cancel)
      input.disposeSignal.removeEventListener('abort', dispose)
    }
    const finish = (message: string): void => {
      if (settled) return
      settled = true
      dispose()
      resolve(message)
    }
    const cancel = () => finish('Isolated grader was cancelled')
    input.signal?.addEventListener('abort', cancel, { once: true })
    input.disposeSignal.addEventListener('abort', dispose, { once: true })
    const diskTimer = setInterval(() => {
      void Promise.all(input.directories.map(directoryBytes))
        .then((sizes) => {
          if (sizes.reduce((sum, size) => sum + size, 0) > input.diskBytes) {
            finish('Isolated grader exceeded its disk budget')
          }
        })
        .catch(() => finish('Isolated grader disk monitoring failed'))
    }, 250)
    diskTimer.unref()
    if (input.signal?.aborted) cancel()
  })
}

async function terminateContainer(name: string): Promise<void> {
  await runDockerCommand(['stop', '--time', '1', name], {
    allowFailure: true,
    timeoutMs: 6_000,
  }).catch(() => undefined)
  await runDockerCommand(['kill', name], { allowFailure: true }).catch(
    () => undefined,
  )
}

async function removeContainer(name: string): Promise<boolean> {
  try {
    const removed = await runDockerCommand(
      ['rm', '--force', '--volumes', name],
      {
        allowFailure: true,
      },
    )
    return removed.exitCode === 0
  } catch {
    return false
  }
}

function mount(source: string, destination: string, readOnly = false): string {
  if (source.includes(',') || /[\r\n\0]/u.test(source)) {
    throw new Error('Grader mount path contains an unsupported character')
  }
  return `type=bind,src=${source},dst=${destination}${readOnly ? ',readonly' : ''}`
}

function safeMessage(error: unknown): string {
  if (error instanceof DockerWorkerUnsupportedError) return error.message
  if (error instanceof DockerCommandError) return error.message.slice(0, 2_048)
  if (error instanceof Error) return error.message.slice(0, 2_048)
  return 'Isolated grader failed'
}
