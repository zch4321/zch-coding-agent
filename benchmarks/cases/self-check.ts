import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  BenchmarkCommand,
  LoadedBenchmarkCase,
  PrivateCaseSpec,
} from './contracts'
import { loadPrivateCaseSpec } from './loader'
import { prepareBenchmarkWorkspace } from './prepare'
import { runBenchmarkCommand, runGit } from './process'

interface CheckOutcome {
  id: string
  groupId: string
  passed: boolean
  exitCode: number
}

export interface CaseSelfCheckEvidence {
  caseId: string
  repetitions: number
  baselineCommit: string
  baselineExpected: 'fail' | 'pass'
  baselineFailedChecks: string[]
  oraclePassed: boolean
  mutants: Array<{ id: string; failedGroups: string[] }>
  stableSignature: string
}

/** Verifies that a case's private spec and archive agree with their recorded signatures. */
export async function selfCheckBenchmarkCase(
  loaded: LoadedBenchmarkCase,
): Promise<CaseSelfCheckEvidence> {
  const privateSpec = await loadPrivateCaseSpec(loaded)
  const signatures: string[] = []
  let lastEvidence: Omit<CaseSelfCheckEvidence, 'stableSignature'> | undefined
  for (
    let repetition = 0;
    repetition < loaded.manifest.quality.repetitions;
    repetition += 1
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-case-check-'))
    try {
      const baselineWorkspace = path.join(root, 'baseline')
      const baselinePrepared = await prepareBenchmarkWorkspace({
        loadedCase: loaded,
        destination: baselineWorkspace,
      })
      await runSetup(loaded, baselineWorkspace)
      const baseline = await runAllChecks(
        loaded,
        privateSpec,
        baselineWorkspace,
      )
      const baselineFailedChecks = baseline
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .sort()
      if (
        loaded.manifest.quality.baselineExpected === 'fail' &&
        baselineFailedChecks.length === 0
      ) {
        throw new Error(
          `Baseline unexpectedly passed for ${loaded.manifest.id}`,
        )
      }
      if (
        loaded.manifest.quality.baselineExpected === 'pass' &&
        baselineFailedChecks.length > 0
      ) {
        throw new Error(
          `No-change baseline unexpectedly failed for ${loaded.manifest.id}`,
        )
      }

      const oracleWorkspace = path.join(root, 'oracle')
      await prepareBenchmarkWorkspace({
        loadedCase: loaded,
        destination: oracleWorkspace,
      })
      if (privateSpec.oracle.kind === 'patch') {
        await applyPatch(oracleWorkspace, privateSpec.oracle.patch)
      }
      await assertModificationScope(loaded, oracleWorkspace)
      await runSetup(loaded, oracleWorkspace)
      const oracle = await runAllChecks(loaded, privateSpec, oracleWorkspace)
      if (oracle.some((check) => !check.passed)) {
        throw new Error(`Oracle failed for ${loaded.manifest.id}`)
      }

      const mutantEvidence: Array<{ id: string; failedGroups: string[] }> = []
      for (const mutant of privateSpec.mutants) {
        const mutantWorkspace = path.join(root, `mutant-${mutant.id}`)
        await prepareBenchmarkWorkspace({
          loadedCase: loaded,
          destination: mutantWorkspace,
        })
        await applyPatch(mutantWorkspace, mutant.patch)
        await assertModificationScope(loaded, mutantWorkspace)
        await runSetup(loaded, mutantWorkspace)
        const publicOutcomes = await runChecks(
          loaded.manifest.publicChecks.map((check) => ({
            id: check.id,
            acceptanceGroupId: check.acceptanceGroupId,
            command: check.command,
          })),
          mutantWorkspace,
        )
        if (publicOutcomes.some((check) => !check.passed)) {
          throw new Error(
            `Mutant ${mutant.id} does not pass public checks for ${loaded.manifest.id}`,
          )
        }
        const privateOutcomes = await runChecks(
          privateSpec.checks,
          mutantWorkspace,
        )
        const failedGroups = [
          ...new Set(
            privateOutcomes
              .filter((check) => !check.passed)
              .map((check) => check.groupId),
          ),
        ].sort()
        if (
          !mutant.expectedFailedGroups.every((group) =>
            failedGroups.includes(group),
          )
        ) {
          throw new Error(
            `Mutant ${mutant.id} escaped expected groups for ${loaded.manifest.id}`,
          )
        }
        mutantEvidence.push({ id: mutant.id, failedGroups })
      }
      const evidence = {
        caseId: loaded.manifest.id,
        repetitions: loaded.manifest.quality.repetitions,
        baselineCommit: baselinePrepared.baselineCommit,
        baselineExpected: loaded.manifest.quality.baselineExpected,
        baselineFailedChecks,
        oraclePassed: true,
        mutants: mutantEvidence,
      }
      const signature = JSON.stringify(evidence)
      signatures.push(signature)
      lastEvidence = evidence
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  if (new Set(signatures).size !== 1 || !lastEvidence) {
    throw new Error(`Self-check is flaky for ${loaded.manifest.id}`)
  }
  return { ...lastEvidence, stableSignature: signatures[0]! }
}

async function runSetup(
  loaded: LoadedBenchmarkCase,
  workspace: string,
): Promise<void> {
  for (const command of loaded.manifest.setup) {
    const result = await runBenchmarkCommand({ command, workspace })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Case setup failed for ${loaded.manifest.id}`)
    }
  }
}

async function runAllChecks(
  loaded: LoadedBenchmarkCase,
  privateSpec: PrivateCaseSpec,
  workspace: string,
): Promise<CheckOutcome[]> {
  return [
    ...(await runChecks(
      loaded.manifest.publicChecks.map((check) => ({
        id: check.id,
        acceptanceGroupId: check.acceptanceGroupId,
        command: check.command,
      })),
      workspace,
    )),
    ...(await runChecks(privateSpec.checks, workspace)),
  ]
}

async function runChecks(
  checks: Array<{
    id: string
    acceptanceGroupId: string
    command: BenchmarkCommand
  }>,
  workspace: string,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const check of checks) {
    const result = await runBenchmarkCommand({
      command: check.command,
      workspace,
    })
    outcomes.push({
      id: check.id,
      groupId: check.acceptanceGroupId,
      passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
    })
  }
  return outcomes
}

async function applyPatch(workspace: string, patch: string): Promise<void> {
  await runGit({
    workspace,
    args: ['apply', '--recount', '--whitespace=nowarn', '-'],
    stdin: patch,
  })
}

async function assertModificationScope(
  loaded: LoadedBenchmarkCase,
  workspace: string,
): Promise<void> {
  const diff = await runGit({
    workspace,
    args: ['diff', '--name-only', '--no-renames', 'HEAD'],
  })
  const files = diff.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (files.length > loaded.manifest.modificationScope.maxChangedFiles) {
    throw new Error(`Patch changes too many files for ${loaded.manifest.id}`)
  }
  for (const file of files) {
    if (
      !loaded.manifest.modificationScope.allowedPaths.some((pattern) =>
        matchesScope(pattern, file),
      ) ||
      loaded.manifest.modificationScope.deniedPaths.some((pattern) =>
        matchesScope(pattern, file),
      )
    ) {
      throw new Error(`Patch changes a forbidden path: ${file}`)
    }
  }
  const patch = await runGit({ workspace, args: ['diff', '--binary', 'HEAD'] })
  if (
    Buffer.byteLength(patch.stdout) >
    loaded.manifest.modificationScope.maxPatchBytes
  ) {
    throw new Error(`Patch exceeds scope byte limit for ${loaded.manifest.id}`)
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
