import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import {
  HeadlessBenchmarkDecisionSchema,
  HeadlessResultSchema,
  HeadlessStreamEventSchema,
  type HeadlessResult,
} from '../../electron/headless/contracts'
import { compileSchema } from '../../electron/schema-validator'
import { BenchmarkAgentCaseSchema } from '../../shared/benchmark'
import {
  inspectDockerCapability,
  inspectWorkerImage,
  DockerWorkerUnsupportedError,
} from './capabilities'
import {
  DEFAULT_DOCKER_WORKER_LIMITS,
  DOCKER_WORKER_SCHEMA_VERSION,
  type DockerWorkerCleanup,
  type DockerWorkerLimits,
  type DockerWorkerResult,
  type DockerWorkerRunInput,
  type DockerWorkerStatus,
  type DockerWorkerWorkspace,
} from './contracts'
import {
  DockerCommandError,
  runDockerCommand,
  startAttachedDockerContainer,
} from './docker-client'
import {
  directoryBytes,
  ensureSafeRunDirectories,
  removePrivateDirectory,
  writePrivateFile,
} from './files'

const CONTAINER_WORKSPACE = '/workspace'
const CONTAINER_ARTIFACTS = '/artifacts'
const CONTAINER_INPUT = '/run/zch/input'
const CONTAINER_CREDENTIAL = '/run/secrets/provider-credential'
const CONTAINER_UPSTREAM_CREDENTIAL = '/run/secrets/upstream-credential'
const PROVIDER_PROXY_ALIAS = 'zch-provider-proxy'
const validateHeadlessResult = compileSchema(HeadlessResultSchema)
const validateHeadlessStreamEvent = compileSchema(HeadlessStreamEventSchema)
const validateBenchmarkDecision = compileSchema(HeadlessBenchmarkDecisionSchema)
const validateBenchmarkCase = compileSchema(BenchmarkAgentCaseSchema)

interface StopReason {
  status: DockerWorkerStatus
  code: string
  message: string
}

/** Runs docker worker. */
export async function runDockerWorker(
  input: DockerWorkerRunInput,
): Promise<DockerWorkerResult> {
  const startedAt = new Date()
  const startedMs = performance.now()
  const runId = randomUUID()
  const suffix = runId.replaceAll('-', '').slice(0, 12)
  const agentName = `zch-agent-${suffix}`
  const proxyName = `zch-proxy-${suffix}`
  const networkName = `zch-worker-${suffix}`
  let limits = { ...DEFAULT_DOCKER_WORKER_LIMITS }
  await mkdir(input.artifactsDirectory, { recursive: true })
  const stdoutPath = path.resolve(input.artifactsDirectory, 'stdout.jsonl')
  const stderrPath = path.resolve(input.artifactsDirectory, 'stderr.log')
  const workerResultPath = path.resolve(
    input.artifactsDirectory,
    'worker-result.json',
  )
  const proxyStdoutPath = path.resolve(
    input.artifactsDirectory,
    'proxy-stdout.log',
  )
  const proxyStderrPath = path.resolve(
    input.artifactsDirectory,
    'proxy-stderr.log',
  )
  const cleanup: DockerWorkerCleanup = {
    agentRemoved: true,
    proxyRemoved: true,
    networkRemoved: true,
    secretsRemoved: true,
  }
  const result: DockerWorkerResult = {
    schemaVersion: DOCKER_WORKER_SCHEMA_VERSION,
    runId,
    status: 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: startedAt.toISOString(),
    durationMs: 0,
    artifacts: {
      directory: path.resolve(input.artifactsDirectory),
      stdoutPath,
      stderrPath,
      workerResultPath,
    },
    cleanup,
  }

  let privateDirectory: string | undefined
  let agentCreated = false
  let proxyCreated = false
  let networkCreated = false
  try {
    limits = normalizeLimits(input.limits)
    validateInput(input)
    const workspace = resolveWorkspace(input)
    const directories = await ensureSafeRunDirectories({
      workspace:
        workspace.kind === 'bind'
          ? workspace.directory
          : input.workspaceDirectory!,
      artifacts: input.artifactsDirectory,
    })
    await assertDiskBudget(
      workspace.kind === 'bind'
        ? [directories.workspace, directories.artifacts]
        : [directories.artifacts],
      limits.diskBytes,
    )
    const [capability, image] = await Promise.all([
      inspectDockerCapability(),
      inspectWorkerImage(input.image, input.expectedSourceCommit),
    ])
    result.capability = capability
    result.image = image
    result.containerName = agentName

    privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'zch-worker-'))
    await chmod(privateDirectory, 0o700)
    const inputDirectory = path.join(privateDirectory, 'input')
    await mkdir(inputDirectory, { mode: 0o755 })
    const config = structuredClone(input.config)
    config.provider.credentialEnv = 'ZCH_WORKER_PROVIDER_KEY'
    if (input.caseDigest) config.caseDigest = input.caseDigest
    const credentialPath = path.join(privateDirectory, 'provider-credential')
    const configPath = path.join(inputDirectory, 'config.json')
    const taskPath = path.join(inputDirectory, 'task.txt')
    const benchmarkCasePath = path.join(inputDirectory, 'benchmark-case.json')
    const workerToken = randomBytes(32).toString('base64url')

    if (input.credential.mode === 'proxy') {
      config.provider.baseURL = `http://${PROVIDER_PROXY_ALIAS}:8080/`
      await writePrivateFile(credentialPath, workerToken)
    } else {
      await writePrivateFile(credentialPath, input.credential.credential)
    }
    await Promise.all([
      writePrivateFile(configPath, `${JSON.stringify(config)}\n`),
      writePrivateFile(taskPath, input.task),
      ...(input.benchmarkCase
        ? [
            writePrivateFile(
              benchmarkCasePath,
              `${JSON.stringify(input.benchmarkCase)}\n`,
            ),
          ]
        : []),
    ])

    if (input.credential.mode === 'proxy') {
      const upstreamPath = path.join(privateDirectory, 'upstream-credential')
      await writePrivateFile(upstreamPath, input.credential.upstreamCredential)
      await runDockerCommand(['network', 'create', '--internal', networkName])
      networkCreated = true
      cleanup.networkRemoved = false
      result.networkName = networkName
      result.proxyContainerName = proxyName
      await runDockerCommand(
        restrictedCreateArgs({
          name: proxyName,
          image: input.proxyImage ?? input.image,
          network: networkName,
          networkAlias: PROVIDER_PROXY_ALIAS,
          limits: proxyLimits(limits),
          mounts: [
            readOnlyFileMount(credentialPath, CONTAINER_CREDENTIAL),
            readOnlyFileMount(upstreamPath, CONTAINER_UPSTREAM_CREDENTIAL),
          ],
          environment: {
            WORKER_PROXY_TOKEN_FILE: CONTAINER_CREDENTIAL,
            UPSTREAM_API_KEY_FILE: CONTAINER_UPSTREAM_CREDENTIAL,
            UPSTREAM_BASE_URL: input.config.provider.baseURL,
            MAX_PROVIDER_REQUESTS: String(
              Math.min(512, (input.config.limits?.maxStepsPerRun || 32) * 4),
            ),
          },
          command: ['proxy'],
        }),
      )
      proxyCreated = true
      cleanup.proxyRemoved = false
      if (input.credential.allowExternalNetwork !== false) {
        await runDockerCommand(['network', 'connect', 'bridge', proxyName])
      }
      await runDockerCommand(['start', proxyName])
    }

    const network = input.credential.mode === 'proxy' ? networkName : 'bridge'
    await runDockerCommand(
      restrictedCreateArgs({
        name: agentName,
        image: input.image,
        network,
        limits,
        mounts: [
          workspaceMount(workspace, directories.workspace),
          readWriteDirectoryMount(directories.artifacts, CONTAINER_ARTIFACTS),
          readOnlyDirectoryMount(inputDirectory, CONTAINER_INPUT),
          readOnlyFileMount(credentialPath, CONTAINER_CREDENTIAL),
        ],
        environment: {
          ZCH_PROVIDER_CREDENTIAL_FILE: CONTAINER_CREDENTIAL,
          ZCH_RUNTIME_IMAGE_DIGEST: image.digest,
        },
        interactive: Boolean(input.benchmarkControl),
        tmpNoExec: workspace.kind === 'bind',
        command: [
          'run',
          '--workspace',
          workspace.containerPath,
          '--task-file',
          `${CONTAINER_INPUT}/task.txt`,
          '--config',
          `${CONTAINER_INPUT}/config.json`,
          '--artifacts',
          CONTAINER_ARTIFACTS,
          '--timeout-ms',
          String(Math.min(limits.wallTimeMs, 86_400_000)),
          ...(input.benchmarkCase
            ? [
                '--benchmark-case-file',
                `${CONTAINER_INPUT}/benchmark-case.json`,
              ]
            : []),
          ...(input.benchmarkControl
            ? ['--benchmark-protocol', input.benchmarkControl.protocol]
            : []),
        ],
      }),
    )
    agentCreated = true
    cleanup.agentRemoved = false
    result.sandbox = {
      readOnlyRoot: true,
      nonRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      boundedResources: true,
      controlledMounts: true,
      dockerSocketAbsent: true,
      networkPolicyApplied: true,
      fixedYolo: true,
    }
    let phaseHandled = false
    const attached = input.benchmarkControl
      ? startAttachedDockerContainer({
          container: agentName,
          timeoutMs: limits.wallTimeMs + limits.stopGraceMs + 30_000,
          maxOutputBytes: limits.maxLogBytes * 2,
          onStdoutLine: async (line) => {
            let event: unknown
            try {
              event = JSON.parse(line)
            } catch {
              return undefined
            }
            if (!isBenchmarkPhaseReady(event)) return undefined
            if (phaseHandled) {
              throw new Error('Docker worker emitted multiple benchmark phases')
            }
            phaseHandled = true
            const decision = await input.benchmarkControl!.onPhaseReady({
              status: event.status,
              sessionId: event.sessionId,
              runIds: [...event.runIds],
              usage: { ...event.usage },
              tools: { ...event.tools },
            })
            if (!validateBenchmarkDecision(decision)) {
              throw new Error(
                'Benchmark controller returned an invalid decision',
              )
            }
            return JSON.stringify(decision)
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
      : undefined
    if (!input.benchmarkControl) await runDockerCommand(['start', agentName])

    const waitPromise = runDockerCommand(['wait', agentName], {
      timeoutMs: limits.wallTimeMs + limits.stopGraceMs + 30_000,
      allowFailure: true,
    })
    const monitorController = new AbortController()
    const stop = await Promise.race([
      waitPromise.then(() => undefined),
      waitForStop({
        signal: input.signal,
        disposeSignal: monitorController.signal,
        wallTimeMs: limits.wallTimeMs,
        diskBytes: limits.diskBytes,
        directories:
          workspace.kind === 'bind'
            ? [directories.workspace, directories.artifacts]
            : [directories.artifacts],
      }),
    ])
    monitorController.abort()
    if (stop) {
      await terminateContainer(agentName, limits.stopGraceMs)
      result.status = stop.status
      result.error = { code: stop.code, message: stop.message }
    }
    const waited = await waitPromise
    const attachError = await attached
    if (attachError) throw attachError
    const exitCode = Number.parseInt(waited.stdout.trim(), 10)
    if (!Number.isInteger(exitCode)) {
      throw new Error('Docker wait returned an invalid exit code')
    }
    result.exitCode = exitCode
    await collectContainerLogs(
      agentName,
      stdoutPath,
      stderrPath,
      limits.maxLogBytes,
    )
    if (!stop) {
      await assertDiskBudget(
        workspace.kind === 'bind'
          ? [directories.workspace, directories.artifacts]
          : [directories.artifacts],
        limits.diskBytes,
      )
      await applyHeadlessResult(result, directories.artifacts)
    }
  } catch (error) {
    result.status = classifyErrorStatus(error)
    result.error = {
      code: errorCode(error),
      message: safeErrorMessage(error),
    }
  } finally {
    if (agentCreated) {
      await terminateContainer(agentName, limits.stopGraceMs)
      cleanup.agentRemoved = await removeContainer(agentName)
    }
    if (proxyCreated) {
      result.artifacts.proxyStdoutPath = proxyStdoutPath
      result.artifacts.proxyStderrPath = proxyStderrPath
      await collectContainerLogs(
        proxyName,
        proxyStdoutPath,
        proxyStderrPath,
        limits.maxLogBytes,
      ).catch(() => undefined)
      await terminateContainer(proxyName, limits.stopGraceMs)
      cleanup.proxyRemoved = await removeContainer(proxyName)
    }
    if (networkCreated)
      cleanup.networkRemoved = await removeNetwork(networkName)
    if (privateDirectory) {
      cleanup.secretsRemoved = await removePrivateDirectory(privateDirectory)
    }
    if (Object.values(cleanup).some((complete) => !complete)) {
      result.status = 'invalid'
      result.error = {
        code: 'DOCKER_WORKER_CLEANUP_INCOMPLETE',
        message: 'Docker worker cleanup did not remove every run resource',
      }
    }
    result.completedAt = new Date().toISOString()
    result.durationMs = Math.max(0, performance.now() - startedMs)
    await writeJsonAtomic(workerResultPath, result)
  }
  return result
}

function restrictedCreateArgs(input: {
  name: string
  image: string
  network: string
  networkAlias?: string
  limits: DockerWorkerLimits
  mounts: string[]
  environment: Record<string, string>
  command: string[]
  interactive?: boolean
  tmpNoExec?: boolean
}): string[] {
  const args = [
    'create',
    '--name',
    input.name,
    '--init',
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(input.limits.pids),
    '--memory',
    String(input.limits.memoryBytes),
    '--cpus',
    String(input.limits.cpus),
    '--network',
    input.network,
    '--tmpfs',
    `/tmp:rw,${input.tmpNoExec === false ? 'exec,' : 'noexec,'}nosuid,nodev,size=${input.limits.tmpfsBytes},mode=1777`,
    '--tmpfs',
    `/home/zch:rw,nosuid,nodev,size=${input.limits.tmpfsBytes},mode=0700,uid=10001,gid=10001`,
  ]
  if (input.interactive) args.push('--interactive')
  if (input.networkAlias) args.push('--network-alias', input.networkAlias)
  for (const mount of input.mounts) args.push('--mount', mount)
  for (const [name, value] of Object.entries(input.environment)) {
    args.push('--env', `${name}=${value}`)
  }
  args.push(input.image, ...input.command)
  return args
}

function isBenchmarkPhaseReady(value: unknown): value is {
  type: 'benchmark.phase_ready'
  status: import('../../electron/headless/contracts').HeadlessRunStatus
  sessionId: string
  runIds: string[]
  usage: import('../../electron/headless/event-stream').HeadlessUsageTotals
  tools: { proposed: number; completed: number; failed: number }
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.type === 'benchmark.phase_ready' &&
    validateHeadlessStreamEvent(value)
  )
}

function normalizeLimits(
  partial: Partial<DockerWorkerLimits> | undefined,
): DockerWorkerLimits {
  const limits = { ...DEFAULT_DOCKER_WORKER_LIMITS, ...partial }
  const integers: Array<keyof DockerWorkerLimits> = [
    'wallTimeMs',
    'stopGraceMs',
    'memoryBytes',
    'pids',
    'tmpfsBytes',
    'diskBytes',
    'maxLogBytes',
  ]
  for (const key of integers) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new Error(`Docker worker limit is invalid: ${key}`)
    }
  }
  if (!Number.isFinite(limits.cpus) || limits.cpus < 0.1 || limits.cpus > 16) {
    throw new Error('Docker worker CPU limit must be between 0.1 and 16')
  }
  if (limits.wallTimeMs > 86_400_000 || limits.pids > 4_096) {
    throw new Error('Docker worker limit exceeds the supported maximum')
  }
  return limits
}

function proxyLimits(limits: DockerWorkerLimits): DockerWorkerLimits {
  return {
    ...limits,
    cpus: Math.min(1, limits.cpus),
    memoryBytes: Math.min(256 * 1024 * 1024, limits.memoryBytes),
    pids: Math.min(64, limits.pids),
    tmpfsBytes: Math.min(32 * 1024 * 1024, limits.tmpfsBytes),
  }
}

function validateInput(input: DockerWorkerRunInput): void {
  if (input.signal?.aborted) {
    throw new DockerCommandError(
      'DOCKER_CANCELLED',
      'Docker worker was cancelled',
    )
  }
  if (!input.image.trim() || /[\r\n\0]/u.test(input.image)) {
    throw new Error('Docker worker image reference is invalid')
  }
  resolveWorkspace(input)
  if (input.proxyImage && /[\r\n\0]/u.test(input.proxyImage)) {
    throw new Error('Docker worker proxy image reference is invalid')
  }
  if (!input.task.trim() || Buffer.byteLength(input.task) > 1024 * 1024) {
    throw new Error('Docker worker task must be non-empty and at most 1 MiB')
  }
  if (input.benchmarkCase && !validateBenchmarkCase(input.benchmarkCase)) {
    throw new Error('Docker worker benchmark case is invalid')
  }
  const credential =
    input.credential.mode === 'proxy'
      ? input.credential.upstreamCredential
      : input.credential.credential
  if (!credential.trim()) throw new Error('Provider credential is empty')
}

function resolveWorkspace(
  input: DockerWorkerRunInput,
):
  | Required<Extract<DockerWorkerWorkspace, { kind: 'bind' }>>
  | Extract<DockerWorkerWorkspace, { kind: 'volume' }> {
  const workspace: DockerWorkerWorkspace =
    input.workspace ??
    ({ kind: 'bind', directory: input.workspaceDirectory } as const)
  if (workspace.kind === 'bind') {
    if (!workspace.directory.trim()) {
      throw new Error('Docker worker bind workspace is invalid')
    }
    return {
      ...workspace,
      containerPath: validateContainerWorkspacePath(
        workspace.containerPath ?? CONTAINER_WORKSPACE,
      ),
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(workspace.name)) {
    throw new Error('Docker worker volume name is invalid')
  }
  return {
    ...workspace,
    containerPath: validateContainerWorkspacePath(workspace.containerPath),
  }
}

function validateContainerWorkspacePath(value: string): string {
  if (
    !value.startsWith('/') ||
    value === '/' ||
    value === CONTAINER_ARTIFACTS ||
    value.startsWith('/run/') ||
    value.includes(',') ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error('Docker worker container workspace path is invalid')
  }
  return value.replace(/\/+$/u, '')
}

async function waitForStop(input: {
  signal?: AbortSignal
  disposeSignal: AbortSignal
  wallTimeMs: number
  diskBytes: number
  directories: string[]
}): Promise<StopReason> {
  return await new Promise((resolve) => {
    let settled = false
    const dispose = (): void => {
      clearTimeout(wallTimer)
      clearInterval(diskTimer)
      input.signal?.removeEventListener('abort', cancel)
      input.disposeSignal.removeEventListener('abort', dispose)
    }
    const finish = (reason: StopReason): void => {
      if (settled) return
      settled = true
      dispose()
      resolve(reason)
    }
    const cancel = () =>
      finish({
        status: 'cancelled',
        code: 'DOCKER_WORKER_CANCELLED',
        message: 'Docker worker was cancelled',
      })
    input.signal?.addEventListener('abort', cancel, { once: true })
    input.disposeSignal.addEventListener('abort', dispose, { once: true })
    const wallTimer = setTimeout(
      () =>
        finish({
          status: 'timed_out',
          code: 'DOCKER_WORKER_TIMEOUT',
          message: `Docker worker exceeded ${input.wallTimeMs} ms`,
        }),
      input.wallTimeMs,
    )
    const diskTimer = setInterval(() => {
      void Promise.all(input.directories.map(directoryBytes))
        .then((sizes) => {
          if (sizes.reduce((sum, value) => sum + value, 0) > input.diskBytes) {
            finish({
              status: 'failed',
              code: 'DOCKER_WORKER_DISK_LIMIT',
              message:
                'Docker worker exceeded its workspace and artifact disk limit',
            })
          }
        })
        .catch(() => undefined)
    }, 250)
    wallTimer.unref()
    diskTimer.unref()
    if (input.signal?.aborted) cancel()
  })
}

async function collectContainerLogs(
  container: string,
  stdoutPath: string,
  stderrPath: string,
  maxBytes: number,
): Promise<void> {
  const logs = await runDockerCommand(['logs', container], {
    allowFailure: true,
    maxOutputBytes: maxBytes * 2,
  })
  await Promise.all([
    writeFile(stdoutPath, Buffer.from(logs.stdout).subarray(-maxBytes)),
    writeFile(stderrPath, Buffer.from(logs.stderr).subarray(-maxBytes)),
  ])
}

async function applyHeadlessResult(
  result: DockerWorkerResult,
  artifactsDirectory: string,
): Promise<void> {
  try {
    const headless = JSON.parse(
      await readFile(path.join(artifactsDirectory, 'result.json'), 'utf8'),
    ) as HeadlessResult
    if (!validateHeadlessResult(headless)) {
      throw new Error('Headless result failed schema validation')
    }
    result.headlessStatus = headless.status
    result.status =
      headless.status === 'completed'
        ? 'completed'
        : headless.status === 'timed_out'
          ? 'timed_out'
          : headless.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
    if (headless.error) result.error = structuredClone(headless.error)
  } catch {
    result.status = 'failed'
    result.error = {
      code: 'HEADLESS_RESULT_MISSING',
      message: 'Headless worker did not produce a readable result artifact',
    }
  }
}

async function terminateContainer(
  name: string,
  graceMs: number,
): Promise<void> {
  try {
    const seconds = Math.max(1, Math.ceil(graceMs / 1000))
    const stopped = await runDockerCommand(
      ['stop', '--time', String(seconds), name],
      { allowFailure: true, timeoutMs: graceMs + 5_000 },
    )
    if (stopped.exitCode === 0) return
  } catch {
    // Continue to the force-kill fallback.
  }
  await runDockerCommand(['kill', name], { allowFailure: true }).catch(
    () => undefined,
  )
}

async function removeContainer(name: string): Promise<boolean> {
  try {
    const removed = await runDockerCommand(
      ['rm', '--force', '--volumes', name],
      { allowFailure: true },
    )
    return removed.exitCode === 0
  } catch {
    return false
  }
}

async function removeNetwork(name: string): Promise<boolean> {
  try {
    const removed = await runDockerCommand(['network', 'rm', name], {
      allowFailure: true,
    })
    return removed.exitCode === 0
  } catch {
    return false
  }
}

async function assertDiskBudget(
  directories: string[],
  limit: number,
): Promise<void> {
  const sizes = await Promise.all(directories.map(directoryBytes))
  if (sizes.reduce((sum, value) => sum + value, 0) > limit) {
    throw new Error('Docker worker disk budget is invalid or exceeded')
  }
}

function readOnlyFileMount(source: string, destination: string): string {
  return `type=bind,src=${source},dst=${destination},readonly`
}

function readOnlyDirectoryMount(source: string, destination: string): string {
  return `type=bind,src=${source},dst=${destination},readonly`
}

function readWriteDirectoryMount(source: string, destination: string): string {
  return `type=bind,src=${source},dst=${destination}`
}

function workspaceMount(
  workspace:
    | Required<Extract<DockerWorkerWorkspace, { kind: 'bind' }>>
    | Extract<DockerWorkerWorkspace, { kind: 'volume' }>,
  bindDirectory: string,
): string {
  return workspace.kind === 'bind'
    ? readWriteDirectoryMount(bindDirectory, workspace.containerPath)
    : `type=volume,src=${workspace.name},dst=${workspace.containerPath}`
}

function classifyErrorStatus(error: unknown): DockerWorkerStatus {
  if (error instanceof DockerWorkerUnsupportedError) return 'unsupported'
  if (error instanceof DockerCommandError) {
    return error.code === 'DOCKER_CANCELLED' ? 'cancelled' : 'invalid'
  }
  if (
    error instanceof Error &&
    /invalid|must|empty|overlap/iu.test(error.message)
  ) {
    return 'invalid'
  }
  return 'failed'
}

function errorCode(error: unknown): string {
  if (error instanceof DockerCommandError) return error.code
  if (error instanceof DockerWorkerUnsupportedError) return error.code
  return 'DOCKER_WORKER_FAILED'
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_096)
  return 'Docker worker failed'
}
