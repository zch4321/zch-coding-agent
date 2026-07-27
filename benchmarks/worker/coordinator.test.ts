import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HeadlessConfig } from '../../electron/headless/contracts'
import { runDockerWorker } from './coordinator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Docker worker coordinator', () => {
  it('rejects invalid input without contacting Docker and writes a result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-unit-'))
    temporaryDirectories.push(root)
    const workspace = path.join(root, 'workspace')
    const artifacts = path.join(root, 'artifacts')
    await Promise.all([mkdir(workspace), mkdir(artifacts)])

    const result = await runDockerWorker({
      image: 'not-needed',
      workspaceDirectory: workspace,
      artifactsDirectory: artifacts,
      config: config(),
      task: '   ',
      credential: { mode: 'direct', credential: 'not-persisted' },
    })

    expect(result.status).toBe('invalid')
    expect(result.error?.message).toContain('non-empty')
    expect(result.cleanup).toEqual({
      agentRemoved: true,
      proxyRemoved: true,
      networkRemoved: true,
      secretsRemoved: true,
    })
    const artifact = JSON.parse(
      await readFile(result.artifacts.workerResultPath, 'utf8'),
    ) as typeof result
    expect(artifact.runId).toBe(result.runId)
    expect(JSON.stringify(artifact)).not.toContain('not-persisted')
  })

  it('returns structured invalid and cancelled statuses before launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-input-'))
    temporaryDirectories.push(root)
    const workspace = path.join(root, 'workspace')
    const invalidArtifacts = path.join(root, 'invalid-artifacts')
    const cancelledArtifacts = path.join(root, 'cancelled-artifacts')
    await Promise.all([
      mkdir(workspace),
      mkdir(invalidArtifacts),
      mkdir(cancelledArtifacts),
    ])
    const base = {
      image: 'not-needed',
      workspaceDirectory: workspace,
      config: config(),
      task: 'valid task',
      credential: { mode: 'direct', credential: 'ephemeral' } as const,
    }
    const invalid = await runDockerWorker({
      ...base,
      artifactsDirectory: invalidArtifacts,
      limits: { pids: 0 },
    })
    const controller = new AbortController()
    controller.abort()
    const cancelled = await runDockerWorker({
      ...base,
      artifactsDirectory: cancelledArtifacts,
      signal: controller.signal,
    })

    expect(invalid.status).toBe('invalid')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.error?.code).toBe('DOCKER_CANCELLED')
  })

  it('rejects unsafe named-volume workspace inputs before contacting Docker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-volume-'))
    temporaryDirectories.push(root)
    const workspace = path.join(root, 'workspace')
    const artifacts = path.join(root, 'artifacts')
    await Promise.all([mkdir(workspace), mkdir(artifacts)])

    const result = await runDockerWorker({
      image: 'not-needed',
      workspaceDirectory: workspace,
      workspace: {
        kind: 'volume',
        name: '../unsafe',
        containerPath: '/testbed',
      },
      artifactsDirectory: artifacts,
      config: config(),
      task: 'valid task',
      credential: { mode: 'direct', credential: 'ephemeral' },
    })

    expect(result.status).toBe('invalid')
    expect(result.error?.message).toContain('volume name')
  })
})

function config(): HeadlessConfig {
  return {
    schemaVersion: 2,
    provider: {
      id: 'docker-test',
      providerType: 'generic.chat-completions',
      baseURL: 'http://provider.invalid/',
      model: 'fake-model',
      reasoning: 'off',
      credentialEnv: 'IGNORED_BY_COORDINATOR',
    },
    assistant: { language: 'en-US' },
  }
}
