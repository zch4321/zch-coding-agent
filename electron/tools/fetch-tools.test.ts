import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { registerFetchTools } from './fetch-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

function harness(fetcher?: Parameters<typeof registerFetchTools>[2]) {
  const registry = new ToolRegistry()
  if (fetcher) {
    registerFetchTools(
      registry,
      () => toPublicConfig(DEFAULT_APP_CONFIG, false),
      fetcher,
    )
  } else {
    registerFetchTools(registry, () =>
      toPublicConfig(DEFAULT_APP_CONFIG, false),
    )
  }
  return { registry, executor: new ToolExecutor(registry) }
}

async function execute(
  args: Record<string, unknown>,
  options: {
    fetcher?: Parameters<typeof registerFetchTools>[2]
    sessionTemp?: { root: string; artifacts: string; scratch: string }
  } = {},
) {
  const { executor, registry } = harness(options.fetcher)
  const signal = new AbortController().signal
  const call = {
    id: 'call-fetch' as CallId,
    toolId: 'fetch',
    args: args as JsonValue,
    reason: '',
  }
  const inspected = executor.inspectCall(call)
  if (!inspected.ok) {
    return inspected.result
  }

  const context = {
    sessionId: 's' as SessionId,
    runId: 'r' as RunId,
    workspace: { canonicalPath: 'F:/workspace' },
    ...(options.sessionTemp ? { sessionTemp: options.sessionTemp } : {}),
  }
  // yolo auto-allows the side effect so the tool actually runs and we can
  // observe the SSRF guard rejections it surfaces.
  const prepared = await new PermissionPipeline().authorize({
    ...context,
    workspace: 'F:/workspace',
    mode: 'yolo',
    call,
    definition: registry.get('fetch')!,
    config: toPublicConfig(DEFAULT_APP_CONFIG, false),
    signal,
    requestHumanApproval: async () => ({ decision: 'deny' }),
  })

  return prepared.ok
    ? executor.execute(prepared.approvedCall, context, signal)
    : prepared.result
}

describe('fetch tool', () => {
  it('registers as a network.request, review-risk tool', () => {
    const { registry } = harness()
    const definition = registry.get('fetch')
    expect(definition?.effects).toEqual(['network.request'])
    expect(definition?.defaultRisk).toBe('review')
    expect(definition?.supportsAbort).toBe(true)
  })

  it('rejects http URLs because only https is allowed', async () => {
    const result = await execute({ url: 'http://example.com/' })
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_URL' })
  })

  it('rejects private addresses with SSRF guard', async () => {
    const result = await execute({ url: 'https://127.0.0.1/' })
    expect(result).toMatchObject({ status: 'error', code: 'PRIVATE_ADDRESS' })
  })

  it('rejects URLs with embedded credentials', async () => {
    const result = await execute({ url: 'https://token:x@example.com/' })
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_URL' })
  })

  it('always stores the complete fetched result in the Session artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fetch-artifact-'))
    const sessionTemp = {
      root,
      artifacts: path.join(root, 'artifacts'),
      scratch: path.join(root, 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const fetcher = vi.fn(async () => ({
      url: 'https://example.com/final',
      status: 200,
      contentType: 'text/plain',
      body: 'complete fetched body',
      truncated: false,
      totalBytes: 21,
    }))

    const result = await execute(
      { url: 'https://example.com/' },
      { fetcher, sessionTemp },
    )

    expect(result).toMatchObject({
      status: 'ok',
      content: {
        artifactAvailable: true,
        artifactPath: expect.any(String),
      },
    })
    if (result.status !== 'ok') return
    const artifactPath = (result.content as { artifactPath: string })
      .artifactPath
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      body: 'complete fetched body',
      status: 200,
    })
  })

  it('reports capture failure without claiming an artifact exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fetch-artifact-fail-'))
    const blockedArtifacts = path.join(root, 'blocked-artifacts')
    await writeFile(blockedArtifacts, 'not a directory')
    const sessionTemp = {
      root,
      artifacts: blockedArtifacts,
      scratch: path.join(root, 'scratch'),
    }
    await mkdir(sessionTemp.scratch)

    const result = await execute(
      { url: 'https://example.com/' },
      {
        sessionTemp,
        fetcher: async () => ({
          url: 'https://example.com/',
          status: 200,
          contentType: 'text/plain',
          body: 'body',
          truncated: false,
          totalBytes: 4,
        }),
      },
    )

    expect(result).toMatchObject({
      status: 'ok',
      content: {
        artifactAvailable: false,
        captureError: expect.any(String),
      },
    })
    if (result.status === 'ok') {
      expect(result.content).not.toHaveProperty('artifactPath')
    }
  })
})
