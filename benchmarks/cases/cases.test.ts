import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadNativeBenchmarkSuite,
  toAgentCaseDescriptor,
} from '../adapters/native'
import { sha256Bytes } from './hash'
import { loadBenchmarkSuite } from './loader'
import { prepareBenchmarkWorkspace, scanAgentVisibleWorkspace } from './prepare'
import { selfCheckBenchmarkCase } from './self-check'

const benchmarkRoot = path.resolve('benchmarks')
const suiteFile = 'manifests/core-24/suite.json'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Benchmark case manifests', () => {
  it('loads a frozen suite and exposes only the public Agent descriptor', async () => {
    const loaded = await loadNativeBenchmarkSuite({ benchmarkRoot, suiteFile })

    expect(loaded.suite).toMatchObject({
      id: 'core-24',
      revision: 'smoke-v1',
      targetCaseCount: 24,
    })
    expect(loaded.cases.map((entry) => entry.manifest.id)).toEqual([
      'chunk-partitioning',
      'retry-backoff',
      'slugify-normalization',
    ])
    expect(loaded.suiteSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(loaded.adapter).toEqual({ id: 'native', revision: 'native-v1' })
    expect(loaded.suiteIdentitySha256).toMatch(/^[a-f0-9]{64}$/u)
    const dockerIgnore = await readFile(path.resolve('.dockerignore'), 'utf8')
    expect(dockerIgnore).toContain('benchmarks/private')
    expect(dockerIgnore).toContain('benchmarks/manifests')
    expect(dockerIgnore).toContain('benchmarks/archives')
    for (const loadedCase of loaded.cases) {
      const serialized = JSON.stringify(toAgentCaseDescriptor(loadedCase))
      expect(serialized).not.toMatch(
        /privateSpec|oracle|mutant|expectedFailedGroups|fail_to_pass|pass_to_pass/iu,
      )
      expect(serialized).not.toContain(path.resolve('benchmarks'))
      expect(JSON.stringify(loadedCase)).not.toContain(
        path.resolve('benchmarks'),
      )
      expect(JSON.stringify(loadedCase)).not.toMatch(
        /private\/core-24|private\\core-24/iu,
      )
    }
  })

  it('rejects checksum drift, unsafe paths, and invalid budgets before prepare', async () => {
    const copiedRoot = await copyBenchmarkData()
    const copiedSuitePath = path.join(copiedRoot, suiteFile)
    const copiedSuite = JSON.parse(await readFile(copiedSuitePath, 'utf8')) as {
      cases: Array<{
        id: string
        manifest: string
        manifestSha256: string
      }>
    }
    const firstManifest = path.join(copiedRoot, copiedSuite.cases[0]!.manifest)
    await writeFile(firstManifest, `${await readFile(firstManifest, 'utf8')}\n`)
    await expect(
      loadBenchmarkSuite({ benchmarkRoot: copiedRoot, suiteFile }),
    ).rejects.toThrow('Manifest checksum mismatch')

    const unsafeRoot = await copyBenchmarkData()
    const unsafeSuitePath = path.join(unsafeRoot, suiteFile)
    const unsafeSuite = JSON.parse(
      await readFile(unsafeSuitePath, 'utf8'),
    ) as typeof copiedSuite
    unsafeSuite.cases[0]!.manifest = '../outside.json'
    await writeFile(unsafeSuitePath, `${JSON.stringify(unsafeSuite)}\n`)
    await expect(
      loadBenchmarkSuite({ benchmarkRoot: unsafeRoot, suiteFile }),
    ).rejects.toThrow('unsafe')

    const budgetRoot = await copyBenchmarkData()
    const budgetSuitePath = path.join(budgetRoot, suiteFile)
    const budgetSuite = JSON.parse(
      await readFile(budgetSuitePath, 'utf8'),
    ) as typeof copiedSuite
    const budgetManifestPath = path.join(
      budgetRoot,
      budgetSuite.cases[0]!.manifest,
    )
    const budgetManifest = JSON.parse(
      await readFile(budgetManifestPath, 'utf8'),
    ) as { resources: { pids: number } }
    budgetManifest.resources.pids = 1
    const budgetRaw = `${JSON.stringify(budgetManifest)}\n`
    await writeFile(budgetManifestPath, budgetRaw)
    budgetSuite.cases[0]!.manifestSha256 = sha256Bytes(budgetRaw)
    await writeFile(budgetSuitePath, `${JSON.stringify(budgetSuite)}\n`)
    await expect(
      loadBenchmarkSuite({ benchmarkRoot: budgetRoot, suiteFile }),
    ).rejects.toThrow('resources/pids')
  })

  it('prepares an exact Agent-visible tree without future Git history', async () => {
    const loaded = await loadNativeBenchmarkSuite({ benchmarkRoot, suiteFile })
    const root = await temporaryDirectory('case-prepare-')
    const workspace = path.join(root, 'workspace')
    const prepared = await prepareBenchmarkWorkspace({
      loadedCase: loaded.cases[0]!,
      destination: workspace,
    })

    expect(prepared.baselineCommit).toMatch(/^[a-f0-9]{40,64}$/u)
    expect(prepared.treeSha256).toBe(loaded.cases[0]!.identity.treeSha256)
    expect(prepared.files).toEqual([
      'package.json',
      'src/chunk.mjs',
      'test/public.test.mjs',
    ])
    await writeFile(path.join(workspace, 'hidden-grader.txt'), 'private\n')
    await expect(
      scanAgentVisibleWorkspace({
        workspace,
        expectedFiles: [...prepared.files, 'hidden-grader.txt'].sort(),
      }),
    ).rejects.toThrow('private path')
  })

  it('proves baseline, oracle, and two mutants for every smoke case across three repetitions', async () => {
    const loaded = await loadNativeBenchmarkSuite({ benchmarkRoot, suiteFile })
    const evidence = []
    for (const loadedCase of loaded.cases) {
      evidence.push(await selfCheckBenchmarkCase(loadedCase))
    }

    expect(evidence).toHaveLength(3)
    for (const entry of evidence) {
      expect(entry.repetitions).toBe(3)
      expect(entry.baselineCommit).toMatch(/^[a-f0-9]{40,64}$/u)
      expect(entry.baselineExpected).toBe('fail')
      expect(entry.baselineFailedChecks.length).toBeGreaterThan(0)
      expect(entry.oraclePassed).toBe(true)
      expect(entry.mutants).toHaveLength(2)
      expect(
        entry.mutants.every((mutant) => mutant.failedGroups.length > 0),
      ).toBe(true)
    }
  }, 120_000)
})

async function copyBenchmarkData(): Promise<string> {
  const root = await temporaryDirectory('case-loader-')
  await Promise.all(
    ['archives', 'manifests', 'private'].map((directory) =>
      cp(path.join(benchmarkRoot, directory), path.join(root, directory), {
        recursive: true,
      }),
    ),
  )
  return root
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}
