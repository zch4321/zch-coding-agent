import { DockerCommandError, runDockerCommand } from './docker-client'
import type {
  DockerWorkerCapability,
  DockerWorkerImageIdentity,
} from './contracts'

interface DockerInfo {
  ServerVersion?: string
  OSType?: string
  Architecture?: string
  CgroupVersion?: string
  SecurityOptions?: string[]
  MemoryLimit?: boolean
  NanoCpus?: boolean
  PidsLimit?: boolean
}

interface DockerImageInspect {
  Id?: string
  RepoDigests?: string[]
  Architecture?: string
  Os?: string
  Config?: {
    Labels?: Record<string, string>
  }
}

export class DockerWorkerUnsupportedError extends Error {
  readonly code = 'DOCKER_WORKER_UNSUPPORTED'

  constructor(message: string) {
    super(message)
    this.name = 'DockerWorkerUnsupportedError'
  }
}

export async function inspectDockerCapability(): Promise<DockerWorkerCapability> {
  const result = await runDockerCommand(['info', '--format', '{{json .}}'])
  const info = parseJson<DockerInfo>(result.stdout, 'Docker info')
  const securityOptions = info.SecurityOptions ?? []
  const architecture = normalizeArchitecture(info.Architecture ?? '')
  if (info.OSType !== 'linux') {
    throw new DockerWorkerUnsupportedError(
      'Docker server must run Linux containers',
    )
  }
  if (architecture !== 'amd64') {
    throw new DockerWorkerUnsupportedError(
      `Docker server architecture is unsupported: ${info.Architecture ?? 'unknown'}`,
    )
  }
  if (!securityOptions.some((option) => option.includes('seccomp'))) {
    throw new DockerWorkerUnsupportedError('Docker seccomp support is required')
  }
  if (
    info.MemoryLimit === false ||
    info.NanoCpus === false ||
    info.PidsLimit === false
  ) {
    throw new DockerWorkerUnsupportedError(
      'Docker CPU, memory, and PID limits must be available',
    )
  }
  return {
    dockerVersion: info.ServerVersion ?? 'unknown',
    operatingSystem: 'linux',
    architecture,
    cgroupVersion: info.CgroupVersion ?? 'unknown',
    securityOptions,
  }
}

export async function inspectWorkerImage(
  reference: string,
  expectedSourceCommit?: string,
): Promise<DockerWorkerImageIdentity> {
  let result: Awaited<ReturnType<typeof runDockerCommand>>
  try {
    result = await runDockerCommand(['image', 'inspect', reference])
  } catch (error) {
    if (error instanceof DockerCommandError) {
      throw new DockerWorkerUnsupportedError(
        `Docker worker image is unavailable: ${reference}`,
      )
    }
    throw error
  }
  const inspections = parseJson<DockerImageInspect[]>(
    result.stdout,
    'Docker image inspect',
  )
  const inspection = inspections[0]
  if (!inspection) {
    throw new DockerWorkerUnsupportedError('Docker worker image was not found')
  }
  const labels = inspection.Config?.Labels ?? {}
  const identity: DockerWorkerImageIdentity = {
    reference,
    digest: inspection.RepoDigests?.[0] ?? inspection.Id ?? 'unknown',
    sourceCommit: labels['org.opencontainers.image.revision'] ?? 'unknown',
    sourceTree: labels['com.zch.source-tree'] ?? 'unknown',
    platform: labels['com.zch.runtime.platform'] ?? 'unknown',
    libc: labels['com.zch.runtime.libc'] ?? 'unknown',
    nodeVersion: labels['com.zch.runtime.node'] ?? 'unknown',
  }
  if (
    inspection.Os !== 'linux' ||
    normalizeArchitecture(inspection.Architecture ?? '') !== 'amd64' ||
    identity.platform !== 'linux-x64' ||
    identity.libc !== 'glibc' ||
    !/^v?24(?:\.|$)/u.test(identity.nodeVersion)
  ) {
    throw new DockerWorkerUnsupportedError(
      'Worker image must be Linux x64, glibc, and Node 24 LTS',
    )
  }
  if (
    expectedSourceCommit &&
    identity.sourceCommit !== expectedSourceCommit.trim()
  ) {
    throw new DockerWorkerUnsupportedError(
      `Worker image source commit mismatch: expected ${expectedSourceCommit}, received ${identity.sourceCommit}`,
    )
  }
  return identity
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new DockerWorkerUnsupportedError(`${label} returned invalid JSON`)
  }
}

function normalizeArchitecture(value: string): string {
  return value === 'x86_64' ? 'amd64' : value
}
