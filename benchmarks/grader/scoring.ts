import type { LoadedBenchmarkCase } from '../cases/contracts'
import type {
  BenchmarkEvaluationResult,
  BenchmarkHardGate,
} from '../runner/contracts'
import type { GraderCommandOutcome, IsolatedGraderRunResult } from './contracts'

/** Returns or updates score isolated grader state. */
export function scoreIsolatedGrader(input: {
  loadedCase: LoadedBenchmarkCase
  grader: IsolatedGraderRunResult
  additionalGates?: BenchmarkHardGate[]
}): BenchmarkEvaluationResult {
  const graderGates = createGraderGates(input.grader)
  const hardGates = [...graderGates, ...(input.additionalGates ?? [])]
  const output = input.grader.output
  const publicChecks = input.loadedCase.manifest.publicChecks.map((check) => {
    const outcome = output?.commands.find(
      (candidate) => candidate.stage === 'public' && candidate.id === check.id,
    )
    return {
      id: check.id,
      title: check.title,
      acceptanceGroupId: check.acceptanceGroupId,
      passed: outcome?.passed ?? false,
    }
  })
  const groups = input.loadedCase.manifest.acceptanceGroups.map((group) => {
    const publicOutcomes = outcomesForGroup(
      output?.commands ?? [],
      'public',
      group.id,
    )
    const privateOutcomes = outcomesForGroup(
      output?.commands ?? [],
      'private',
      group.id,
    )
    const publicPassed = publicOutcomes.every((outcome) => outcome.passed)
    const privatePassed = privateOutcomes.every((outcome) => outcome.passed)
    const hasEvidence = publicOutcomes.length + privateOutcomes.length > 0
    return {
      id: group.id,
      title: group.title,
      critical: group.critical,
      weight: group.weight,
      passed: hasEvidence && publicPassed && privatePassed,
      publicPassed,
      privatePassed,
      evidence: {
        public: summary(publicOutcomes),
        private: summary(privateOutcomes),
      },
    }
  })
  const status = evaluationStatus(input.grader, hardGates)
  const setupPassed =
    output?.status === 'completed' &&
    output.commands
      .filter((outcome) => outcome.stage === 'setup')
      .every((outcome) => outcome.passed)
  const publicPassed =
    publicChecks.length > 0 && publicChecks.every((check) => check.passed)
  const passedGroups = groups.filter((group) => group.passed).length
  const criticalGroups = groups.filter((group) => group.critical)
  const criticalPassed =
    criticalGroups.length > 0
      ? criticalGroups.every((group) => group.passed)
      : groups.every((group) => group.passed)
  const patchLegal =
    input.grader.patch.applies &&
    input.grader.patch.scopeCompliant &&
    input.grader.patch.hygienePassed
  let level: BenchmarkEvaluationResult['level'] = 'L0'
  if (input.grader.patch.present && patchLegal) {
    level = 'L1'
    if (setupPassed) level = 'L2'
    if (setupPassed && publicPassed) level = 'L3'
    if (setupPassed && publicPassed && passedGroups > 0) level = 'L4'
    if (setupPassed && publicPassed && criticalPassed) level = 'L5'
  }
  const resolved =
    status === 'graded' &&
    level === 'L5' &&
    hardGates.every((gate) => gate.passed)
  return {
    schemaVersion: 2,
    status,
    resolved,
    level,
    groupMacroScore: groups.length === 0 ? 0 : passedGroups / groups.length,
    patchSha256: input.grader.patch.sha256,
    failureCategory: failureCategory({
      grader: input.grader,
      status,
      level,
      hardGates,
    }),
    hardGates,
    publicChecks,
    groups,
    grader: {
      revision: input.grader.graderRevision,
      imageDigest: input.grader.graderImageDigest,
      inputSha256: input.grader.inputSha256,
    },
    error: input.grader.error,
  }
}

function createGraderGates(
  grader: IsolatedGraderRunResult,
): BenchmarkHardGate[] {
  const gates: BenchmarkHardGate[] = [
    gate('patch_applies', grader.patch.applies, 'agent'),
    gate('modification_scope', grader.patch.scopeCompliant, 'agent'),
    gate('patch_hygiene', grader.patch.hygienePassed, 'agent'),
    gate(
      'grader_cleanup',
      grader.cleanup.containerRemoved && grader.cleanup.privateDirectoryRemoved,
      'infrastructure',
    ),
  ]
  if (grader.status === 'attempted') return gates
  gates.push(
    gate(
      'grader_sandbox',
      Object.values(grader.sandbox).every(Boolean),
      'infrastructure',
    ),
    gate('grader_input_immutable', grader.inputImmutable, 'infrastructure'),
    gate(
      'grader_completed',
      grader.status === 'completed' && grader.output?.status === 'completed',
      'infrastructure',
    ),
  )
  return gates
}

function gate(
  id: BenchmarkHardGate['id'],
  passed: boolean,
  owner: BenchmarkHardGate['owner'],
): BenchmarkHardGate {
  return { id, passed, owner }
}

function outcomesForGroup(
  outcomes: GraderCommandOutcome[],
  stage: 'public' | 'private',
  groupId: string,
): GraderCommandOutcome[] {
  return outcomes.filter(
    (outcome) =>
      outcome.stage === stage && outcome.acceptanceGroupId === groupId,
  )
}

function summary(outcomes: GraderCommandOutcome[]): {
  passed: number
  total: number
  failureCategories: GraderCommandOutcome['failureCategory'][]
} {
  return {
    passed: outcomes.filter((outcome) => outcome.passed).length,
    total: outcomes.length,
    failureCategories: [
      ...new Set(
        outcomes
          .filter((outcome) => !outcome.passed)
          .map((outcome) => outcome.failureCategory),
      ),
    ],
  }
}

function evaluationStatus(
  grader: IsolatedGraderRunResult,
  hardGates: BenchmarkHardGate[],
): BenchmarkEvaluationResult['status'] {
  if (grader.status === 'unsupported') return 'unsupported'
  if (
    grader.status === 'invalid' ||
    hardGates.some((gate) => !gate.passed && gate.owner === 'infrastructure')
  ) {
    return 'invalid'
  }
  if (
    grader.status === 'attempted' ||
    hardGates.some((gate) => !gate.passed && gate.owner === 'agent')
  ) {
    return 'attempted'
  }
  return 'graded'
}

function failureCategory(input: {
  grader: IsolatedGraderRunResult
  status: BenchmarkEvaluationResult['status']
  level: BenchmarkEvaluationResult['level']
  hardGates: BenchmarkHardGate[]
}): BenchmarkEvaluationResult['failureCategory'] {
  if (input.status === 'unsupported') return 'unsupported'
  if (input.status === 'invalid') return 'infrastructure_failed'
  if (!input.grader.patch.present) return 'no_change'
  if (!input.grader.patch.applies) return 'patch_invalid'
  if (!input.grader.patch.scopeCompliant) return 'scope_violation'
  if (!input.grader.patch.hygienePassed) return 'patch_hygiene_failed'
  if (input.level === 'L1') return 'setup_failed'
  if (input.level === 'L2') return 'regression_failed'
  if (input.level === 'L3' || input.level === 'L4') return 'acceptance_failed'
  if (input.hardGates.some((gate) => !gate.passed)) return 'hard_gate_failed'
  return 'none'
}
