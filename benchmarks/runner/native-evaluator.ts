import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BenchmarkCommand, LoadedBenchmarkCase } from '../cases/contracts'
import { sha256Bytes } from '../cases/hash'
import { loadPrivateCaseSpec } from '../cases/loader'
import { prepareBenchmarkWorkspace } from '../cases/prepare'
import { runBenchmarkCommand, runGit } from '../cases/process'
import type {
  BenchmarkCheckOutcome,
  BenchmarkGroupOutcome,
  NativeEvaluationResult,
} from './contracts'

interface InternalCheckOutcome {
  id: string
  groupId: string
  passed: boolean
}

/** Collects the bounded Git diff produced by the benchmark workspace. */
export async function collectBenchmarkPatch(input: {
  workspace: string
  maxPatchBytes: number
}): Promise<string> {
  const result = await runGit({
    workspace: input.workspace,
    args: ['diff', '--binary', '--no-ext-diff', 'HEAD'],
    maxOutputBytes: input.maxPatchBytes + 1,
  })
  if (Buffer.byteLength(result.stdout) > input.maxPatchBytes) {
    throw new Error('Benchmark patch exceeds its byte limit')
  }
  return result.stdout
}

/** Evaluates a native patch against case policy and public and private hard gates. */
export async function evaluateNativePatch(input: {
  loadedCase: LoadedBenchmarkCase
  patch: string
}): Promise<NativeEvaluationResult> {
  const patchSha256 = sha256Bytes(input.patch)
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-grader-'))
  const workspace = path.join(root, 'workspace')
  try {
    await prepareBenchmarkWorkspace({
      loadedCase: input.loadedCase,
      destination: workspace,
    })
    try {
      if (input.patch) {
        await runGit({
          workspace,
          args: ['apply', '--recount', '--whitespace=nowarn', '-'],
          stdin: input.patch,
        })
      }
      await assertModificationScope(input.loadedCase, workspace)
    } catch {
      return invalidEvaluation(patchSha256, 'patch_invalid')
    }

    try {
      for (const command of input.loadedCase.manifest.setup) {
        const setup = await runBenchmarkCommand({ command, workspace })
        if (setup.exitCode !== 0 || setup.timedOut) {
          return invalidEvaluation(patchSha256, 'setup_failed')
        }
      }
    } catch {
      return invalidEvaluation(patchSha256, 'setup_failed')
    }

    const privateSpec = await loadPrivateCaseSpec(input.loadedCase)
    const publicChecks = await runPublicChecks(input.loadedCase, workspace)
    const privateChecks = await runChecks(privateSpec.checks, workspace)
    const groups = groupOutcomes(input.loadedCase, publicChecks, privateChecks)
    const resolved = groups.every((group) => group.passed)
    const publicFailed = publicChecks.some((check) => !check.passed)
    return {
      schemaVersion: 1,
      status: 'graded',
      resolved,
      patchSha256,
      failureCategory: resolved
        ? 'none'
        : publicFailed
          ? 'public_check_failed'
          : 'acceptance_failed',
      publicChecks,
      groups,
    }
  } catch {
    return invalidEvaluation(patchSha256, 'grader_failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runPublicChecks(
  loadedCase: LoadedBenchmarkCase,
  workspace: string,
): Promise<BenchmarkCheckOutcome[]> {
  const outcomes: BenchmarkCheckOutcome[] = []
  for (const check of loadedCase.manifest.publicChecks) {
    const result = await runBenchmarkCommand({
      command: check.command,
      workspace,
    })
    outcomes.push({
      id: check.id,
      title: check.title,
      acceptanceGroupId: check.acceptanceGroupId,
      passed: result.exitCode === 0 && !result.timedOut,
    })
  }
  return outcomes
}

async function runChecks(
  checks: Array<{
    id: string
    acceptanceGroupId: string
    command: BenchmarkCommand
  }>,
  workspace: string,
): Promise<InternalCheckOutcome[]> {
  const outcomes: InternalCheckOutcome[] = []
  for (const check of checks) {
    const result = await runBenchmarkCommand({
      command: check.command,
      workspace,
    })
    outcomes.push({
      id: check.id,
      groupId: check.acceptanceGroupId,
      passed: result.exitCode === 0 && !result.timedOut,
    })
  }
  return outcomes
}

function groupOutcomes(
  loadedCase: LoadedBenchmarkCase,
  publicChecks: BenchmarkCheckOutcome[],
  privateChecks: InternalCheckOutcome[],
): BenchmarkGroupOutcome[] {
  return loadedCase.manifest.acceptanceGroups.map((group) => {
    const publicForGroup = publicChecks.filter(
      (check) => check.acceptanceGroupId === group.id,
    )
    const privateForGroup = privateChecks.filter(
      (check) => check.groupId === group.id,
    )
    const publicPassed = publicForGroup.every((check) => check.passed)
    const privatePassed = privateForGroup.every((check) => check.passed)
    return {
      id: group.id,
      title: group.title,
      critical: group.critical,
      passed: publicPassed && privatePassed,
      publicPassed,
      privatePassed,
    }
  })
}

async function assertModificationScope(
  loadedCase: LoadedBenchmarkCase,
  workspace: string,
): Promise<void> {
  const scope = loadedCase.manifest.modificationScope
  const names = await runGit({
    workspace,
    args: ['diff', '--name-only', '--no-renames', 'HEAD'],
  })
  const files = names.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (files.length > scope.maxChangedFiles) {
    throw new Error('Patch changes too many files')
  }
  for (const file of files) {
    if (
      !scope.allowedPaths.some((pattern) => matchesScope(pattern, file)) ||
      scope.deniedPaths.some((pattern) => matchesScope(pattern, file))
    ) {
      throw new Error('Patch changes a forbidden path')
    }
  }
  const diff = await runGit({
    workspace,
    args: ['diff', '--binary', '--no-ext-diff', 'HEAD'],
    maxOutputBytes: scope.maxPatchBytes + 1,
  })
  if (Buffer.byteLength(diff.stdout) > scope.maxPatchBytes) {
    throw new Error('Patch exceeds its byte limit')
  }
  await runGit({ workspace, args: ['diff', '--check', 'HEAD'] })
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

function invalidEvaluation(
  patchSha256: string,
  failureCategory: NativeEvaluationResult['failureCategory'],
): NativeEvaluationResult {
  return {
    schemaVersion: 1,
    status: 'invalid',
    resolved: false,
    patchSha256,
    failureCategory,
    publicChecks: [],
    groups: [],
    error: {
      code: `BENCHMARK_${failureCategory.toUpperCase()}`,
      message: 'The evaluator could not grade this patch',
    },
  }
}
