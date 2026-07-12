import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HeadlessConfig } from '../../electron/headless/contracts'
import { runDockerWorker } from './coordinator'
import { runDockerCommand } from './docker-client'

const execFileAsync = promisify(execFile)
const enabled = process.env.RUN_DOCKER_WORKER_TESTS === '1'
const image = process.env.ZCH_WORKER_IMAGE ?? 'zch-agent-headless:test'
const sourceCommit = process.env.ZCH_EXPECTED_SOURCE_COMMIT
const temporaryDirectories: string[] = []
const fixtureContainers: string[] = []

describe.skipIf(!enabled)('Linux Docker worker', () => {
  beforeAll(async () => {
    await cleanupWorkerResources()
  })

  afterAll(async () => {
    await Promise.all(
      fixtureContainers.map((name) =>
        runDockerCommand(['rm', '--force', name], { allowFailure: true }),
      ),
    )
    await cleanupWorkerResources()
    await Promise.all(
      temporaryDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it('runs the shared fixed-Yolo runtime through the isolated proxy', async () => {
    const fixture = await createFixture('patch')
    const result = await runDockerWorker({
      image,
      workspaceDirectory: fixture.workspace,
      artifactsDirectory: fixture.artifacts,
      config: config(fixture.providerBaseURL),
      task: 'Change note.txt from before to after, then finish.',
      credential: {
        mode: 'proxy',
        upstreamCredential: fixture.upstreamSecret,
        allowExternalNetwork: true,
      },
      expectedSourceCommit: sourceCommit,
      limits: { wallTimeMs: 60_000, stopGraceMs: 1_000 },
    })

    expect(result.status).toBe('completed')
    expect(result.headlessStatus).toBe('completed')
    expect(
      await readFile(path.join(fixture.workspace, 'note.txt'), 'utf8'),
    ).toBe('after\n')
    expect(result.image?.sourceCommit).toBe(sourceCommit)
    expect(result.image?.platform).toBe('linux-x64')
    expect(result.image?.libc).toBe('glibc')
    expect(result.cleanup).toEqual({
      agentRemoved: true,
      proxyRemoved: true,
      networkRemoved: true,
      secretsRemoved: true,
    })
    const artifacts = await readArtifacts(fixture.artifacts)
    expect(artifacts).not.toContain(fixture.upstreamSecret)
    await expectNoWorkerResources()
  }, 90_000)

  it('keeps repair-once in one attached container and session', async () => {
    const fixture = await createFixture('patch')
    let phases = 0
    let initialSession = ''
    const result = await runDockerWorker({
      image,
      workspaceDirectory: fixture.workspace,
      artifactsDirectory: fixture.artifacts,
      config: config(fixture.providerBaseURL),
      task: 'Change note.txt from before to after, then finish.',
      credential: {
        mode: 'proxy',
        upstreamCredential: fixture.upstreamSecret,
        allowExternalNetwork: true,
      },
      expectedSourceCommit: sourceCommit,
      limits: { wallTimeMs: 60_000, stopGraceMs: 1_000 },
      benchmarkControl: {
        protocol: 'repair-once',
        onPhaseReady: async (phase) => {
          phases += 1
          initialSession = phase.sessionId
          return {
            schemaVersion: 1,
            action: 'repair',
            feedback: {
              visibility: 'public',
              text: 'Re-check the requested file and finish the task.',
            },
          }
        },
      },
    })

    expect(result.status).toBe('completed')
    expect(phases).toBe(1)
    const headless = JSON.parse(
      await readFile(path.join(fixture.artifacts, 'result.json'), 'utf8'),
    ) as {
      sessionId: string
      benchmark: {
        repairAttempted: boolean
        initialRunIds: string[]
        repairRunIds: string[]
      }
    }
    expect(headless.sessionId).toBe(initialSession)
    expect(headless.benchmark.repairAttempted).toBe(true)
    expect(headless.benchmark.initialRunIds).toHaveLength(1)
    expect(headless.benchmark.repairRunIds).toHaveLength(1)
    expect(
      await readFile(path.join(fixture.workspace, 'note.txt'), 'utf8'),
    ).toBe('after\n')
    await expectNoWorkerResources()
  }, 90_000)

  it('enforces the sandbox and removes resources after a forced timeout', async () => {
    const fixture = await createFixture('hang')
    const running = runDockerWorker({
      image,
      workspaceDirectory: fixture.workspace,
      artifactsDirectory: fixture.artifacts,
      config: config(fixture.providerBaseURL),
      task: 'Wait for the provider response.',
      credential: {
        mode: 'proxy',
        upstreamCredential: fixture.upstreamSecret,
        allowExternalNetwork: true,
      },
      expectedSourceCommit: sourceCommit,
      limits: {
        wallTimeMs: 5_000,
        stopGraceMs: 1_000,
        memoryBytes: 512 * 1024 * 1024,
        pids: 64,
      },
    })
    const agentName = await waitForAgentContainer()
    const inspection = await inspectContainer(agentName)
    expect(inspection.HostConfig.ReadonlyRootfs).toBe(true)
    expect(inspection.HostConfig.CapDrop).toContain('ALL')
    expect(inspection.HostConfig.PidsLimit).toBe(64)
    expect(inspection.HostConfig.Memory).toBe(512 * 1024 * 1024)
    expect(inspection.HostConfig.SecurityOpt).toContain('no-new-privileges')
    expect(inspection.HostConfig.NetworkMode).toMatch(/^zch-worker-/u)
    expect(inspection.Mounts.map((mount) => mount.Destination).sort()).toEqual([
      '/artifacts',
      '/run/secrets/provider-credential',
      '/run/zch/input',
      '/workspace',
    ])
    expect(JSON.stringify(inspection.Mounts)).not.toMatch(/docker\.sock/iu)
    expect(JSON.stringify(inspection.Config.Env)).not.toContain(
      fixture.upstreamSecret,
    )

    const result = await running
    expect(result.status).toBe('timed_out')
    expect(result.error?.code).toBe('DOCKER_WORKER_TIMEOUT')
    expect(result.cleanup).toEqual({
      agentRemoved: true,
      proxyRemoved: true,
      networkRemoved: true,
      secretsRemoved: true,
    })
    await expectNoWorkerResources()
  }, 30_000)
})

async function createFixture(mode: 'patch' | 'hang'): Promise<{
  workspace: string
  artifacts: string
  providerBaseURL: string
  upstreamSecret: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-e2e-'))
  temporaryDirectories.push(root)
  const workspace = path.join(root, 'workspace')
  const artifacts = path.join(root, 'artifacts')
  await Promise.all([mkdir(workspace), mkdir(artifacts)])
  await writeFile(path.join(workspace, 'note.txt'), 'before\n')
  await execFileAsync('git', ['init'], { cwd: workspace })
  await execFileAsync('git', ['add', '.'], { cwd: workspace })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Docker Worker Test',
      '-c',
      'user.email=worker@example.invalid',
      'commit',
      '-m',
      'baseline',
    ],
    { cwd: workspace },
  )
  const upstreamSecret = `upstream-secret-${mode}-${Date.now()}`
  const secretPath = path.join(root, 'upstream-key')
  await writeFile(secretPath, upstreamSecret, { mode: 0o444 })
  await chmod(secretPath, 0o444)
  const name = `zch-fake-${mode}-${Date.now()}`
  fixtureContainers.push(name)
  await runDockerCommand([
    'create',
    '--name',
    name,
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'bridge',
    '--mount',
    `type=bind,src=${secretPath},dst=/run/secrets/upstream-key,readonly`,
    '--env',
    'UPSTREAM_API_KEY_FILE=/run/secrets/upstream-key',
    '--env',
    `FAKE_PROVIDER_MODE=${mode}`,
    image,
    'fake-provider',
  ])
  await runDockerCommand(['start', name])
  const address = await runDockerCommand([
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    name,
  ])
  return {
    workspace,
    artifacts,
    providerBaseURL: `http://${address.stdout.trim()}:8081/`,
    upstreamSecret,
  }
}

function config(baseURL: string): HeadlessConfig {
  return {
    schemaVersion: 1,
    provider: {
      id: 'docker-fake',
      baseURL,
      model: 'docker-fake-model',
      reasoning: 'off',
      credentialEnv: 'REWRITTEN_BY_COORDINATOR',
    },
    assistant: { language: 'en-US' },
  }
}

async function waitForAgentContainer(): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await runDockerCommand([
      'ps',
      '--filter',
      'name=^/zch-agent-',
      '--format',
      '{{.Names}}',
    ])
    const name = result.stdout.trim().split(/\r?\n/u).find(Boolean)
    if (name) return name
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the Agent container')
}

async function inspectContainer(name: string): Promise<{
  HostConfig: {
    ReadonlyRootfs: boolean
    CapDrop: string[]
    PidsLimit: number
    Memory: number
    SecurityOpt: string[]
    NetworkMode: string
  }
  Mounts: Array<{ Destination: string }>
  Config: { Env: string[] }
}> {
  const result = await runDockerCommand(['inspect', name])
  return JSON.parse(result.stdout)[0]
}

async function readArtifacts(directory: string): Promise<string> {
  const names = [
    'result.json',
    'identity.json',
    'trace.jsonl',
    'patch.diff',
    'stdout.jsonl',
    'stderr.log',
    'proxy-stdout.log',
    'proxy-stderr.log',
    'worker-result.json',
    'runtime/config.json',
    'runtime/secrets.json',
  ]
  const contents = await Promise.all(
    names.map(async (name) => {
      try {
        return await readFile(path.join(directory, name), 'utf8')
      } catch {
        return ''
      }
    }),
  )
  return contents.join('\n')
}

async function expectNoWorkerResources(): Promise<void> {
  const containers = await runDockerCommand([
    'ps',
    '--all',
    '--filter',
    'name=^/zch-(agent|proxy)-',
    '--format',
    '{{.Names}}',
  ])
  const networks = await runDockerCommand([
    'network',
    'ls',
    '--filter',
    'name=^zch-worker-',
    '--format',
    '{{.Name}}',
  ])
  expect(containers.stdout.trim()).toBe('')
  expect(networks.stdout.trim()).toBe('')
}

async function cleanupWorkerResources(): Promise<void> {
  const containers = await runDockerCommand([
    'ps',
    '--all',
    '--filter',
    'name=^/zch-(agent|proxy)-',
    '--format',
    '{{.Names}}',
  ])
  for (const name of containers.stdout.trim().split(/\r?\n/u).filter(Boolean)) {
    await runDockerCommand(['rm', '--force', name], { allowFailure: true })
  }
  const networks = await runDockerCommand([
    'network',
    'ls',
    '--filter',
    'name=^zch-worker-',
    '--format',
    '{{.Name}}',
  ])
  for (const name of networks.stdout.trim().split(/\r?\n/u).filter(Boolean)) {
    await runDockerCommand(['network', 'rm', name], { allowFailure: true })
  }
}
