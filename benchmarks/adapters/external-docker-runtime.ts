import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import type {
  ExternalBenchmarkCandidate,
  ResolvedExternalImage,
  SweRebenchPrivatePayload,
} from '../cohort/contracts'
import { candidateHash } from '../cohort/selection'
import { sha256Bytes } from '../cases/hash'
import {
  ISOLATED_GRADER_REVISION,
  type GraderCommandOutcome,
  type IsolatedGraderRunResult,
} from '../grader/contracts'
import {
  runDockerCommand,
  type DockerCommandResult,
} from '../worker/docker-client'
import type {
  ExternalAdapterRuntime,
  ExternalPreparedWorkspace,
} from './external'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_VERIFIER_OUTPUT_BYTES = 4 * 1024 * 1024

interface ExternalImageInfo {
  taskImage: string
  taskImageDigest: string
  agentImage: string
  agentImageDigest: string
  workspace: string
  taskDirectory?: string
}

export interface ExternalDockerRuntimeOptions {
  cacheDirectory: string
  runtimeImage: string
  sourceCommit: string
  sourceTreeState?: string
  overlayDockerfile?: string
  fetch?: typeof fetch
}

export class ExternalDockerRuntime implements ExternalAdapterRuntime {
  readonly #options: ExternalDockerRuntimeOptions
  readonly #images = new Map<string, ExternalImageInfo>()
  readonly #volumes = new Set<string>()

  constructor(options: ExternalDockerRuntimeOptions) {
    this.#options = options
  }

  async resolveImage(
    candidate: ExternalBenchmarkCandidate,
  ): Promise<ResolvedExternalImage> {
    try {
      const info = await this.#ensureImages(candidate)
      const compatible = await this.#ensureCompatibility(candidate, info)
      return compatible
        ? {
            eligible: true,
            officialReference: info.taskImage,
            officialDigest: info.taskImageDigest,
            agentImageDigest: info.agentImageDigest,
          }
        : { eligible: false, reason: 'compatibility_failed' }
    } catch {
      return { eligible: false, reason: 'image_unavailable' }
    }
  }

  async prepare(
    input: Parameters<ExternalAdapterRuntime['prepare']>[0],
  ): Promise<ExternalPreparedWorkspace> {
    const info = await this.#ensureImages(input.candidate)
    if (
      info.taskImageDigest !== input.cohortCase.officialImage.digest ||
      info.agentImageDigest !== input.cohortCase.agentImageDigest
    ) {
      throw new Error('External task image drifted from the pinned cohort')
    }
    if (info.agentImage !== input.agentImageReference) {
      await runDockerCommand([
        'image',
        'tag',
        info.agentImage,
        input.agentImageReference,
      ])
      info.agentImage = input.agentImageReference
    }
    await mkdir(input.destination, { recursive: true })
    const volume = this.#volumeName(input.candidate.caseId)
    await this.#initializeVolume(volume, info.agentImage, info.workspace)
    return {
      directory: input.destination,
      mount: { kind: 'volume', name: volume, containerPath: info.workspace },
    }
  }

  async capturePatch(
    input: Parameters<ExternalAdapterRuntime['capturePatch']>[0],
  ): Promise<string> {
    const result = await runDockerCommand(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '10001:10001',
        '--entrypoint',
        'git',
        '--mount',
        volumeMount(
          input.workspace.mount.name,
          input.workspace.mount.containerPath,
        ),
        '--workdir',
        input.workspace.mount.containerPath,
        input.agentImageReference,
        'diff',
        '--binary',
        '--no-ext-diff',
        'HEAD',
      ],
      { maxOutputBytes: input.maxPatchBytes + 1, timeoutMs: 60_000 },
    )
    if (Buffer.byteLength(result.stdout, 'utf8') > input.maxPatchBytes) {
      throw new Error('External benchmark patch exceeds its byte limit')
    }
    return result.stdout
  }

  async grade(
    input: Parameters<ExternalAdapterRuntime['grade']>[0],
  ): Promise<IsolatedGraderRunResult> {
    const startedAt = new Date()
    const startedMs = performance.now()
    const patchSha256 = sha256Bytes(input.graderInput.patch)
    const artifacts = path.resolve(input.graderInput.artifactsDirectory)
    await mkdir(artifacts, { recursive: true })
    const stdoutPath = path.join(artifacts, 'stdout.log')
    const stderrPath = path.join(artifacts, 'stderr.log')
    const coordinatorResultPath = path.join(
      artifacts,
      'coordinator-result.restricted.json',
    )
    const result = baseGraderResult({
      startedAt,
      patchSha256,
      patchPresent: Buffer.byteLength(input.graderInput.patch, 'utf8') > 0,
      imageDigest: input.cohortCase.agentImageDigest,
      artifacts,
      stdoutPath,
      stderrPath,
      coordinatorResultPath,
    })
    let privateDirectory: string | undefined
    let volume: string | undefined
    try {
      const info = await this.#ensureImages(input.candidate)
      privateDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'zch-external-grader-'),
      )
      await chmod(privateDirectory, 0o700)
      await writeFile(
        path.join(privateDirectory, 'agent.patch'),
        input.graderInput.patch,
        { mode: 0o400 },
      )
      volume = this.#volumeName(`${input.candidate.caseId}-grader`)
      await this.#initializeVolume(
        volume,
        input.agentImageReference,
        info.workspace,
      )
      const preflight = await this.#preflightPatch({
        image: input.agentImageReference,
        workspace: info.workspace,
        volume,
        privateDirectory,
        patchPresent: Boolean(input.graderInput.patch),
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
          code: 'EXTERNAL_PATCH_HARD_GATE',
          message: 'The external patch failed deterministic preflight',
        }
        return result
      }
      const verifier = await this.#executeVerifier({
        candidate: input.candidate,
        info,
        volume,
        privateDirectory,
        patchFile: input.graderInput.patch ? 'agent.patch' : undefined,
      })
      await Promise.all([
        writeFile(stdoutPath, bounded(verifier.command.stdout), 'utf8'),
        writeFile(stderrPath, bounded(verifier.command.stderr), 'utf8'),
      ])
      const inputSha256 = sha256Bytes(
        JSON.stringify({
          caseHash: input.cohortCase.caseHash,
          patchSha256,
          targetGroupIds: input.targetGroupIds,
        }),
      )
      result.inputSha256 = inputSha256
      result.inputImmutable = true
      result.output = {
        schemaVersion: 1,
        graderRevision: ISOLATED_GRADER_REVISION,
        status: 'completed',
        inputSha256,
        caseId: input.graderInput.loadedCase.manifest.id,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - startedMs),
        commands: verifierOutcomes(verifier, input.targetGroupIds),
      }
      result.status = 'completed'
      result.sandbox = completeSandbox()
      const rawReportPath = path.join(artifacts, 'raw-report.restricted.json')
      await writeJsonAtomic(rawReportPath, result.output)
      result.artifacts.rawReportPath = rawReportPath
    } catch (error) {
      result.status = 'invalid'
      result.error = {
        code: 'EXTERNAL_GRADER_FAILED',
        message: safeMessage(error),
      }
    } finally {
      if (volume)
        result.cleanup.containerRemoved = await this.#removeVolume(volume)
      if (privateDirectory) {
        await rm(privateDirectory, { recursive: true, force: true })
      }
      result.cleanup.privateDirectoryRemoved = true
      result.completedAt = new Date().toISOString()
      result.durationMs = Math.max(0, performance.now() - startedMs)
      await writeJsonAtomic(coordinatorResultPath, result)
    }
    return result
  }

  async dispose(workspaces: ExternalPreparedWorkspace[]): Promise<void> {
    await Promise.all(
      workspaces.map((workspace) => this.#removeVolume(workspace.mount.name)),
    )
  }

  async #ensureImages(
    candidate: ExternalBenchmarkCandidate,
  ): Promise<ExternalImageInfo> {
    const key = `${candidate.source}:${candidate.caseId}:${candidate.commit}`
    const existing = this.#images.get(key)
    if (existing) return existing
    await mkdir(this.#options.cacheDirectory, { recursive: true })
    const task: {
      image: string
      workspace: string
      taskDirectory?: string
    } =
      candidate.privatePayload.kind === 'monthly-swebench'
        ? await this.#buildMonthlyTaskImage(candidate)
        : await this.#pullRebenchImage(candidate)
    const agentImage = `zch-external-build/${candidate.source}:${candidateHash(candidate).slice(0, 20)}`
    await runDockerCommand(
      [
        'build',
        '--platform',
        'linux/amd64',
        '--file',
        path.resolve(
          this.#options.overlayDockerfile ??
            'benchmarks/docker/external-overlay.Dockerfile',
        ),
        '--build-arg',
        `ZCH_RUNTIME_IMAGE=${this.#options.runtimeImage}`,
        '--build-arg',
        `TASK_IMAGE=${task.image}`,
        '--build-arg',
        `TASK_WORKSPACE=${task.workspace}`,
        '--build-arg',
        `ZCH_SOURCE_COMMIT=${this.#options.sourceCommit}`,
        '--build-arg',
        `ZCH_SOURCE_TREE_STATE=${this.#options.sourceTreeState ?? 'unknown'}`,
        '--tag',
        agentImage,
        '.',
      ],
      { timeoutMs: 20 * 60_000, maxOutputBytes: 8 * 1024 * 1024 },
    )
    const info: ExternalImageInfo = {
      taskImage: task.image,
      taskImageDigest: await imageId(task.image),
      agentImage,
      agentImageDigest: await imageId(agentImage),
      workspace: task.workspace,
      taskDirectory: task.taskDirectory,
    }
    this.#images.set(key, info)
    return info
  }

  async #buildMonthlyTaskImage(
    candidate: ExternalBenchmarkCandidate,
  ): Promise<{ image: string; workspace: string; taskDirectory: string }> {
    const payload = candidate.privatePayload
    if (payload.kind !== 'monthly-swebench')
      throw new Error('Expected Monthly-SWEBench payload')
    const releaseDirectory = path.join(
      this.#options.cacheDirectory,
      'monthly',
      candidate.commit,
    )
    const archivePath = path.join(releaseDirectory, payload.archiveFile)
    const taskDirectory = path.join(releaseDirectory, 'tasks', candidate.caseId)
    await mkdir(path.dirname(taskDirectory), { recursive: true })
    if (!(await exists(archivePath))) {
      const base = `https://huggingface.co/datasets/${candidate.dataset}/resolve/${candidate.commit}`
      const sums = await fetchBounded(
        this.#options.fetch ?? fetch,
        `${base}/SHA256SUMS`,
        1024 * 1024,
      )
      const expected = sums
        .toString('utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u))
        .find((parts) => parts.at(-1) === payload.archiveFile)?.[0]
      if (!expected || !/^[a-f0-9]{64}$/u.test(expected))
        throw new Error('Monthly archive checksum is unavailable')
      const archive = await fetchBounded(
        this.#options.fetch ?? fetch,
        `${base}/${payload.archiveFile}`,
        MAX_ARCHIVE_BYTES,
      )
      if (sha256Bytes(archive) !== expected)
        throw new Error('Monthly archive checksum mismatch')
      await mkdir(releaseDirectory, { recursive: true })
      await writeFile(archivePath, archive)
    }
    if (!(await exists(taskDirectory))) {
      await execFileAsync(
        'tar',
        [
          '-xf',
          archivePath,
          '-C',
          path.dirname(taskDirectory),
          candidate.caseId,
        ],
        { windowsHide: true, timeout: 120_000 },
      )
    }
    const instruction = await readFile(
      path.join(taskDirectory, 'instruction.md'),
      'utf8',
    )
    candidate.problemStatement = instruction.trim()
    const taskToml = await readFile(
      path.join(taskDirectory, 'task.toml'),
      'utf8',
    )
    candidate.language = inferMonthlyLanguage(taskToml)
    const image = `zch-task/monthly:${candidateHash(candidate).slice(0, 20)}`
    await runDockerCommand(
      [
        'build',
        '--platform',
        'linux/amd64',
        '--file',
        path.join(taskDirectory, 'environment', 'Dockerfile'),
        '--tag',
        image,
        path.join(taskDirectory, 'environment'),
      ],
      { timeoutMs: 30 * 60_000, maxOutputBytes: 8 * 1024 * 1024 },
    )
    return { image, workspace: await imageWorkspace(image), taskDirectory }
  }

  async #pullRebenchImage(
    candidate: ExternalBenchmarkCandidate,
  ): Promise<{ image: string; workspace: string }> {
    await runDockerCommand(
      ['pull', '--platform', 'linux/amd64', candidate.officialImageReference],
      {
        timeoutMs: 30 * 60_000,
        maxOutputBytes: 8 * 1024 * 1024,
      },
    )
    return {
      image: candidate.officialImageReference,
      workspace: await imageWorkspace(candidate.officialImageReference),
    }
  }

  async #ensureCompatibility(
    candidate: ExternalBenchmarkCandidate,
    info: ExternalImageInfo,
  ): Promise<boolean> {
    const directory = path.join(this.#options.cacheDirectory, 'compatibility')
    const file = path.join(
      directory,
      `${candidateHash(candidate)}-${info.taskImageDigest.slice(7)}.json`,
    )
    if (await exists(file)) {
      const cached = JSON.parse(await readFile(file, 'utf8')) as {
        baselineResolved: boolean
        oracleResolved: boolean
      }
      return !cached.baselineResolved && cached.oracleResolved
    }
    await mkdir(directory, { recursive: true })
    const baseline = await this.#compatibilityAttempt(candidate, info, false)
    const oracle = await this.#compatibilityAttempt(candidate, info, true)
    const record = {
      schemaVersion: 1,
      adapterRevision: candidate.adapterRevision,
      caseHash: candidateHash(candidate),
      officialImageDigest: info.taskImageDigest,
      baselineResolved: baseline,
      oracleResolved: oracle,
      checkedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(file, record)
    return !baseline && oracle
  }

  async #compatibilityAttempt(
    candidate: ExternalBenchmarkCandidate,
    info: ExternalImageInfo,
    oracle: boolean,
  ): Promise<boolean> {
    const privateDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'zch-external-compat-'),
    )
    const volume = this.#volumeName(
      `${candidate.caseId}-${oracle ? 'oracle' : 'baseline'}`,
    )
    try {
      await this.#initializeVolume(volume, info.agentImage, info.workspace)
      if (candidate.privatePayload.kind === 'swe-rebench') {
        await writeFile(
          path.join(privateDirectory, 'test.patch'),
          candidate.privatePayload.testPatch,
        )
        if (oracle)
          await writeFile(
            path.join(privateDirectory, 'oracle.patch'),
            candidate.privatePayload.solutionPatch,
          )
      }
      const verifier = await this.#executeVerifier({
        candidate,
        info,
        volume,
        privateDirectory,
        oracle,
      })
      return (
        verifier.regressionPassed &&
        verifier.targetResults.length > 0 &&
        verifier.targetResults.every(Boolean)
      )
    } finally {
      await this.#removeVolume(volume)
      await rm(privateDirectory, { recursive: true, force: true })
    }
  }

  async #preflightPatch(input: {
    image: string
    workspace: string
    volume: string
    privateDirectory: string
    patchPresent: boolean
  }): Promise<{
    applies: boolean
    scopeCompliant: boolean
    hygienePassed: boolean
  }> {
    if (!input.patchPresent)
      return { applies: true, scopeCompliant: true, hygienePassed: true }
    const command = await runDockerCommand(
      restrictedRunArgs({
        image: input.image,
        workspace: input.workspace,
        volume: input.volume,
        privateDirectory: input.privateDirectory,
        script:
          'git apply --check /private/agent.patch && git apply /private/agent.patch && git diff --check HEAD && test "$(git diff --name-only HEAD | wc -l)" -le 1000',
      }),
      { allowFailure: true, timeoutMs: 60_000 },
    )
    return {
      applies: command.exitCode === 0,
      scopeCompliant: command.exitCode === 0,
      hygienePassed: command.exitCode === 0,
    }
  }

  async #executeVerifier(input: {
    candidate: ExternalBenchmarkCandidate
    info: ExternalImageInfo
    volume: string
    privateDirectory: string
    patchFile?: string
    oracle?: boolean
  }): Promise<VerifierResult> {
    const mounts: string[] = []
    let script = ''
    if (input.candidate.privatePayload.kind === 'monthly-swebench') {
      if (!input.info.taskDirectory)
        throw new Error('Monthly task files are unavailable')
      mounts.push(
        bindMount(
          path.join(input.info.taskDirectory, 'tests'),
          '/private/tests',
          true,
        ),
      )
      mounts.push(
        bindMount(
          path.join(input.info.taskDirectory, 'solution'),
          '/private/solution',
          true,
        ),
      )
      script = [
        input.patchFile ? `git apply /private/${input.patchFile}` : '',
        input.oracle ? 'bash /private/solution/solve.sh' : '',
        'REWARD_FILE=/tmp/reward.txt bash /private/tests/test.sh',
      ]
        .filter(Boolean)
        .join(' && ')
    } else {
      const payload = input.candidate.privatePayload
      if (!(await exists(path.join(input.privateDirectory, 'test.patch')))) {
        await writeFile(
          path.join(input.privateDirectory, 'test.patch'),
          payload.testPatch,
        )
      }
      if (
        input.oracle &&
        !(await exists(path.join(input.privateDirectory, 'oracle.patch')))
      ) {
        await writeFile(
          path.join(input.privateDirectory, 'oracle.patch'),
          payload.solutionPatch,
        )
      }
      const testCommand = rebenchTestCommand(payload)
      script = [
        input.patchFile ? `git apply /private/${input.patchFile}` : '',
        input.oracle ? 'git apply /private/oracle.patch' : '',
        'git apply /private/test.patch',
        testCommand,
      ]
        .filter(Boolean)
        .join(' && ')
    }
    const command = await runDockerCommand(
      restrictedRunArgs({
        image: input.info.agentImage,
        workspace: input.info.workspace,
        volume: input.volume,
        privateDirectory: input.privateDirectory,
        extraMounts: mounts,
        script,
      }),
      {
        allowFailure: true,
        timeoutMs: 15 * 60_000,
        maxOutputBytes: MAX_VERIFIER_OUTPUT_BYTES,
      },
    )
    return parseExternalVerifier(input.candidate, command)
  }

  async #initializeVolume(
    volume: string,
    image: string,
    workspace: string,
  ): Promise<void> {
    await runDockerCommand(['volume', 'create', volume])
    this.#volumes.add(volume)
    const container = `zch-volume-init-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    try {
      await runDockerCommand([
        'create',
        '--name',
        container,
        '--entrypoint',
        '/bin/sh',
        '--mount',
        volumeMount(volume, workspace),
        image,
        '-c',
        'true',
      ])
      await runDockerCommand(['start', container])
      await runDockerCommand(['wait', container], { allowFailure: true })
    } finally {
      await runDockerCommand(['rm', '--force', container], {
        allowFailure: true,
      }).catch(() => undefined)
    }
  }

  async #removeVolume(volume: string): Promise<boolean> {
    const result = await runDockerCommand(['volume', 'rm', '--force', volume], {
      allowFailure: true,
    }).catch(() => undefined)
    this.#volumes.delete(volume)
    return result?.exitCode === 0
  }

  #volumeName(caseId: string): string {
    const suffix = sha256Bytes(`${caseId}:${randomUUID()}`).slice(0, 20)
    return `zch-benchmark-${suffix}`
  }
}

interface VerifierResult {
  command: DockerCommandResult
  regressionPassed: boolean
  targetResults: boolean[]
}

export function parseExternalVerifier(
  candidate: ExternalBenchmarkCandidate,
  command: DockerCommandResult,
): VerifierResult {
  const output = `${command.stdout}\n${command.stderr}`
  if (candidate.privatePayload.kind === 'monthly-swebench') {
    const regressions = labeledResults(output, /\[REGRESSION[^\]]*\]/u)
    const targets = labeledResults(output, /\[FAIL2PASS[^\]]*\]/u)
    return {
      command,
      regressionPassed:
        regressions.length === 0
          ? command.exitCode === 0
          : regressions.every(Boolean),
      targetResults: targets.length === 0 ? [command.exitCode === 0] : targets,
    }
  }
  const payload = candidate.privatePayload
  return {
    command,
    regressionPassed:
      payload.passToPass.length === 0 ||
      payload.passToPass.every((test) =>
        testPassed(output, test, command.exitCode),
      ),
    targetResults: payload.failToPass.map((test) =>
      testPassed(output, test, command.exitCode),
    ),
  }
}

function verifierOutcomes(
  verifier: VerifierResult,
  groupIds: string[],
): GraderCommandOutcome[] {
  const now = 0
  const outcome = (
    stage: 'setup' | 'public' | 'private',
    id: string,
    passed: boolean,
    acceptanceGroupId?: string,
  ): GraderCommandOutcome => ({
    stage,
    id,
    ...(acceptanceGroupId ? { acceptanceGroupId } : {}),
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: now,
    stdoutSha256: sha256Bytes(verifier.command.stdout),
    stderrSha256: sha256Bytes(verifier.command.stderr),
    failureCategory: passed ? 'none' : 'exit_nonzero',
  })
  const shards = groupIds.map((_, index) =>
    verifier.targetResults.filter(
      (__, targetIndex) => targetIndex % groupIds.length === index,
    ),
  )
  return [
    outcome('setup', 'verifier-start', true),
    outcome('public', 'regression', verifier.regressionPassed, 'regression'),
    ...groupIds.map((groupId, index) =>
      outcome(
        'private',
        groupId,
        (shards[index]?.length ?? 0) > 0 && shards[index]!.every(Boolean),
        groupId,
      ),
    ),
  ]
}

function restrictedRunArgs(input: {
  image: string
  workspace: string
  volume: string
  privateDirectory: string
  script: string
  extraMounts?: string[]
}): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    String(8 * 1024 * 1024 * 1024),
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    volumeMount(input.volume, input.workspace),
    '--mount',
    bindMount(input.privateDirectory, '/private', true),
    ...(input.extraMounts ?? []).flatMap((mount) => ['--mount', mount]),
    '--workdir',
    input.workspace,
    input.image,
    '-c',
    input.script,
  ]
}

function rebenchTestCommand(payload: SweRebenchPrivatePayload): string {
  const installConfig = isRecord(payload.verifier.installConfig)
    ? payload.verifier.installConfig
    : {}
  const command =
    typeof installConfig.test_cmd === 'string'
      ? installConfig.test_cmd.trim()
      : ''
  if (!command) throw new Error('SWE-rebench verifier test command is missing')
  return command
}

function labeledResults(output: string, role: RegExp): boolean[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => role.test(line) && /:\s*(?:PASS|FAIL)/u.test(line))
    .map((line) => /:\s*PASS/u.test(line))
}

function testPassed(
  output: string,
  test: string,
  fallbackExitCode: number,
): boolean {
  const lines = output.split(/\r?\n/u).filter((line) => line.includes(test))
  if (lines.some((line) => /(?:PASSED|PASS|ok)\b/iu.test(line))) return true
  if (lines.some((line) => /(?:FAILED|FAIL|ERROR)\b/iu.test(line))) return false
  return fallbackExitCode === 0
}

function baseGraderResult(input: {
  startedAt: Date
  patchSha256: string
  patchPresent: boolean
  imageDigest: string
  artifacts: string
  stdoutPath: string
  stderrPath: string
  coordinatorResultPath: string
}): IsolatedGraderRunResult {
  return {
    schemaVersion: 1,
    status: 'invalid',
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: input.imageDigest,
    inputSha256: sha256Bytes(''),
    startedAt: input.startedAt.toISOString(),
    completedAt: input.startedAt.toISOString(),
    durationMs: 0,
    patch: {
      sha256: input.patchSha256,
      present: input.patchPresent,
      applies: false,
      scopeCompliant: false,
      hygienePassed: false,
    },
    sandbox: completeSandbox(false),
    inputImmutable: false,
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: input.artifacts,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      coordinatorResultPath: input.coordinatorResultPath,
    },
  }
}

function completeSandbox(value = true) {
  return {
    networkDisabled: value,
    readOnlyRoot: value,
    nonRoot: value,
    capabilitiesDropped: value,
    noNewPrivileges: value,
    boundedResources: value,
    privateInputReadOnly: value,
    dockerSocketAbsent: value,
  }
}

async function imageId(image: string): Promise<string> {
  const result = await runDockerCommand([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image,
  ])
  const value = result.stdout.trim()
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error('Docker image digest is invalid')
  return value
}

async function imageWorkspace(image: string): Promise<string> {
  const result = await runDockerCommand([
    'image',
    'inspect',
    '--format',
    '{{.Config.WorkingDir}}',
    image,
  ])
  const value = result.stdout.trim().replace(/\/+$/u, '')
  if (!value.startsWith('/') || value === '/')
    throw new Error('External task image has no safe native workspace')
  return value
}

async function fetchBounded(
  request: typeof fetch,
  url: string,
  maxBytes: number,
): Promise<Buffer> {
  const response = await request(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok)
    throw new Error(`External dataset download failed (${response.status})`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes)
    throw new Error('External dataset download exceeds byte limit')
  const value = Buffer.from(await response.arrayBuffer())
  if (value.byteLength > maxBytes)
    throw new Error('External dataset download exceeds byte limit')
  return value
}

function volumeMount(volume: string, destination: string): string {
  return `type=volume,src=${volume},dst=${destination}`
}

function bindMount(
  source: string,
  destination: string,
  readOnly = false,
): string {
  return `type=bind,src=${path.resolve(source)},dst=${destination}${readOnly ? ',readonly' : ''}`
}

function inferMonthlyLanguage(taskToml: string): string {
  const value = taskToml.toLowerCase()
  for (const language of [
    'python',
    'go',
    'rust',
    'java',
    'typescript',
    'javascript',
    'c++',
    'c',
  ]) {
    if (
      new RegExp(`['\"]${language.replace('+', '\\+')}['\"]`, 'u').test(value)
    )
      return language
  }
  return 'unknown'
}

function bounded(value: string): string {
  const buffer = Buffer.from(value, 'utf8')
  return buffer.byteLength <= MAX_VERIFIER_OUTPUT_BYTES
    ? value
    : buffer
        .subarray(buffer.byteLength - MAX_VERIFIER_OUTPUT_BYTES)
        .toString('utf8')
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 4_096)
    : 'Unexpected external grader failure'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function exists(value: string): Promise<boolean> {
  try {
    await stat(value)
    return true
  } catch {
    return false
  }
}
