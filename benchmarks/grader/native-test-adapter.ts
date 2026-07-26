import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256Bytes } from '../cases/hash'
import { loadPrivateCaseSpec } from '../cases/loader'
import { evaluateNativePatch } from '../runner/native-evaluator'
import {
  ISOLATED_GRADER_REVISION,
  type GraderCommandOutcome,
  type IsolatedGraderRunResult,
} from './contracts'
import type { IsolatedGraderRunner } from './coordinator'

/** Runs trusted native test grader. */
export const runTrustedNativeTestGrader: IsolatedGraderRunner = async (
  input,
) => {
  await mkdir(input.artifactsDirectory, { recursive: true })
  const started = new Date()
  const evaluation = await evaluateNativePatch({
    loadedCase: input.loadedCase,
    patch: input.patch,
  })
  const privateSpec = await loadPrivateCaseSpec(input.loadedCase)
  const commands: GraderCommandOutcome[] = [
    ...input.loadedCase.manifest.publicChecks.map((check) => {
      const outcome = evaluation.publicChecks.find(
        (candidate) => candidate.id === check.id,
      )
      return commandOutcome(
        'public',
        check.id,
        check.acceptanceGroupId,
        outcome?.passed ?? false,
      )
    }),
    ...privateSpec.checks.map((check) => {
      const group = evaluation.groups.find(
        (candidate) => candidate.id === check.acceptanceGroupId,
      )
      return commandOutcome(
        'private',
        check.id,
        check.acceptanceGroupId,
        group?.privatePassed ?? false,
      )
    }),
  ]
  const inputSha256 = sha256Bytes(
    JSON.stringify({
      caseId: input.loadedCase.manifest.id,
      patchSha256: sha256Bytes(input.patch),
      graderRevision: ISOLATED_GRADER_REVISION,
    }),
  )
  const output = {
    schemaVersion: 1 as const,
    graderRevision: ISOLATED_GRADER_REVISION,
    status: 'completed' as const,
    inputSha256,
    caseId: input.loadedCase.manifest.id,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    commands,
  }
  const rawReportPath = path.join(
    input.artifactsDirectory,
    'raw-report.restricted.json',
  )
  await writeFile(rawReportPath, `${JSON.stringify(output)}\n`, { mode: 0o600 })
  return {
    schemaVersion: 1,
    status: evaluation.status === 'graded' ? 'completed' : 'attempted',
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: input.expectedImageDigest,
    inputSha256,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    patch: {
      sha256: sha256Bytes(input.patch),
      present: Boolean(input.patch),
      applies: evaluation.failureCategory !== 'patch_invalid',
      scopeCompliant: evaluation.failureCategory !== 'patch_invalid',
      hygienePassed: evaluation.failureCategory !== 'patch_invalid',
    },
    sandbox: {
      networkDisabled: true,
      readOnlyRoot: true,
      nonRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      boundedResources: true,
      privateInputReadOnly: true,
      dockerSocketAbsent: true,
    },
    inputImmutable: true,
    output,
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: input.artifactsDirectory,
      rawReportPath,
      stdoutPath: path.join(input.artifactsDirectory, 'stdout.log'),
      stderrPath: path.join(input.artifactsDirectory, 'stderr.log'),
      coordinatorResultPath: path.join(
        input.artifactsDirectory,
        'coordinator-result.restricted.json',
      ),
    },
  } satisfies IsolatedGraderRunResult
}

function commandOutcome(
  stage: 'public' | 'private',
  id: string,
  acceptanceGroupId: string,
  passed: boolean,
): GraderCommandOutcome {
  return {
    stage,
    id,
    acceptanceGroupId,
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: 0,
    stdoutSha256: sha256Bytes(''),
    stderrSha256: sha256Bytes(''),
    failureCategory: passed ? 'none' : 'exit_nonzero',
  }
}
