import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  loadNativeBenchmarkSuite,
  type NativeBenchmarkSuite,
} from '../adapters/native'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import { sha256Bytes } from '../cases/hash'
import { prepareBenchmarkWorkspace } from '../cases/prepare'
import { collectBenchmarkPatch } from '../runner/native-evaluator'
import {
  ISOLATED_GRADER_REVISION,
  type IsolatedGraderInput,
  type IsolatedGraderOutput,
} from './contracts'
import { runIsolatedGrader } from './coordinator'
import { runGraderService } from './service'

const temporaryDirectories: string[] = []
let suite: NativeBenchmarkSuite
let loadedCase: LoadedBenchmarkCase

beforeAll(async () => {
  suite = await loadNativeBenchmarkSuite({
    benchmarkRoot: path.resolve('benchmarks'),
    suiteFile: 'manifests/core-24/suite.json',
  })
  loadedCase = suite.cases.find(
    (candidate) => candidate.manifest.id === 'slugify-normalization',
  )!
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('isolated grader service', () => {
  it('stores command hashes and outcomes without persisting command output', async () => {
    const root = await temporaryDirectory()
    const workspace = path.join(root, 'workspace')
    const inputPath = path.join(root, 'grader-input.json')
    const outputPath = path.join(root, 'grader-output.json')
    await mkdir(workspace)
    const secretOutput = 'PRIVATE-EXPECTED-VALUE-DO-NOT-PERSIST'
    const command = {
      executable: 'node',
      args: ['-e', `process.stdout.write('${secretOutput}')`],
      timeoutMs: 5_000,
      maxOutputBytes: 65_536,
    }
    const input: IsolatedGraderInput = {
      schemaVersion: 1,
      graderRevision: ISOLATED_GRADER_REVISION,
      caseIdentity: {
        caseId: 'service-fixture',
        suiteId: 'test-suite',
        suiteRevision: 'v1',
        manifestSha256: 'a'.repeat(64),
        privateSpecSha256: 'b'.repeat(64),
        patchSha256: 'c'.repeat(64),
      },
      setup: [],
      publicChecks: [
        {
          id: 'public-check',
          title: 'Public check',
          acceptanceGroupId: 'behavior',
          command,
        },
      ],
      privateChecks: [
        {
          id: 'private-check',
          acceptanceGroupId: 'behavior',
          command,
        },
      ],
      acceptanceGroups: [
        { id: 'behavior', title: 'Behavior', critical: true, weight: 1 },
      ],
    }
    await writeFile(inputPath, `${JSON.stringify(input)}\n`)

    await runGraderService([
      '--workspace',
      workspace,
      '--input',
      inputPath,
      '--output',
      outputPath,
    ])

    const raw = await readFile(outputPath, 'utf8')
    const output = JSON.parse(raw) as IsolatedGraderOutput
    expect(output.status).toBe('completed')
    expect(output.commands).toHaveLength(2)
    expect(output.commands.every((outcome) => outcome.passed)).toBe(true)
    expect(raw).not.toContain(secretOutput)
    expect(output.commands[0]!.stdoutSha256).toBe(sha256Bytes(secretOutput))
  })
})

describe('isolated grader preflight', () => {
  it('classifies an unapplyable patch as attempted without contacting Docker', async () => {
    const root = await temporaryDirectory()
    const result = await runIsolatedGrader({
      loadedCase,
      patch: 'this is not a git patch',
      image: 'docker-must-not-be-used',
      expectedImageDigest: 'sha256:not-used',
      artifactsDirectory: path.join(root, 'artifacts'),
    })

    expect(result.status).toBe('attempted')
    expect(result.patch.applies).toBe(false)
    expect(result.error?.code).toBe('GRADER_PATCH_INVALID')
    expect(result.cleanup).toEqual({
      containerRemoved: true,
      privateDirectoryRemoved: true,
    })
  })

  it('rejects changes to denied test paths before starting a grader', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    await prepareBenchmarkWorkspace({ loadedCase, destination: source })
    const testPath = path.join(source, 'test', 'public.test.mjs')
    await writeFile(
      testPath,
      `${await readFile(testPath, 'utf8')}\n// modified\n`,
    )
    const patch = await collectBenchmarkPatch({
      workspace: source,
      maxPatchBytes: 65_536,
    })

    const result = await runIsolatedGrader({
      loadedCase,
      patch,
      image: 'docker-must-not-be-used',
      expectedImageDigest: 'sha256:not-used',
      artifactsDirectory: path.join(root, 'artifacts'),
    })

    expect(result.status).toBe('attempted')
    expect(result.patch.applies).toBe(true)
    expect(result.patch.scopeCompliant).toBe(false)
    expect(result.error?.code).toBe('GRADER_SCOPE_VIOLATION')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-grader-test-'))
  temporaryDirectories.push(directory)
  return directory
}
