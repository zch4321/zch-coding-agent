import type { HeadlessConfig } from '../../electron/headless/contracts'
import type {
  HeadlessBenchmarkDecision,
  HeadlessRunStatus,
  HeadlessStreamEvent,
} from '../../electron/headless/contracts'

export const DOCKER_WORKER_SCHEMA_VERSION = 1 as const

export type DockerWorkerStatus =
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'invalid'
  | 'unsupported'

export interface DockerWorkerLimits {
  wallTimeMs: number
  stopGraceMs: number
  cpus: number
  memoryBytes: number
  pids: number
  tmpfsBytes: number
  diskBytes: number
  maxLogBytes: number
}

export interface DockerWorkerProxyCredential {
  mode: 'proxy'
  upstreamCredential: string
  allowExternalNetwork?: boolean
}

export interface DockerWorkerDirectCredential {
  mode: 'direct'
  credential: string
}

export type DockerWorkerCredential =
  | DockerWorkerProxyCredential
  | DockerWorkerDirectCredential

export interface DockerWorkerRunInput {
  image: string
  workspaceDirectory: string
  artifactsDirectory: string
  config: HeadlessConfig
  task: string
  credential: DockerWorkerCredential
  expectedSourceCommit?: string
  caseDigest?: string
  limits?: Partial<DockerWorkerLimits>
  signal?: AbortSignal
  benchmarkControl?: {
    protocol: 'repair-once'
    onPhaseReady: (phase: {
      status: HeadlessRunStatus
      sessionId: string
      runIds: string[]
      usage: Extract<
        HeadlessStreamEvent,
        { type: 'benchmark.phase_ready' }
      >['usage']
      tools: Extract<
        HeadlessStreamEvent,
        { type: 'benchmark.phase_ready' }
      >['tools']
    }) => Promise<HeadlessBenchmarkDecision>
  }
}

export interface DockerWorkerCapability {
  dockerVersion: string
  operatingSystem: string
  architecture: string
  cgroupVersion: string
  securityOptions: string[]
}

export interface DockerWorkerImageIdentity {
  reference: string
  digest: string
  sourceCommit: string
  sourceTree: string
  platform: string
  libc: string
  nodeVersion: string
}

export interface DockerWorkerCleanup {
  agentRemoved: boolean
  proxyRemoved: boolean
  networkRemoved: boolean
  secretsRemoved: boolean
}

export interface DockerWorkerSandboxEvidence {
  readOnlyRoot: boolean
  nonRoot: boolean
  capabilitiesDropped: boolean
  noNewPrivileges: boolean
  boundedResources: boolean
  controlledMounts: boolean
  dockerSocketAbsent: boolean
  networkPolicyApplied: boolean
  fixedYolo: boolean
}

export interface DockerWorkerResult {
  schemaVersion: typeof DOCKER_WORKER_SCHEMA_VERSION
  runId: string
  status: DockerWorkerStatus
  startedAt: string
  completedAt: string
  durationMs: number
  capability?: DockerWorkerCapability
  image?: DockerWorkerImageIdentity
  sandbox?: DockerWorkerSandboxEvidence
  containerName?: string
  proxyContainerName?: string
  networkName?: string
  exitCode?: number
  headlessStatus?: string
  error?: {
    code: string
    message: string
  }
  artifacts: {
    directory: string
    stdoutPath: string
    stderrPath: string
    proxyStdoutPath?: string
    proxyStderrPath?: string
    workerResultPath: string
  }
  cleanup: DockerWorkerCleanup
}

export const DEFAULT_DOCKER_WORKER_LIMITS: DockerWorkerLimits = {
  wallTimeMs: 15 * 60_000,
  stopGraceMs: 5_000,
  cpus: 2,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
  tmpfsBytes: 256 * 1024 * 1024,
  diskBytes: 2 * 1024 * 1024 * 1024,
  maxLogBytes: 1024 * 1024,
}
