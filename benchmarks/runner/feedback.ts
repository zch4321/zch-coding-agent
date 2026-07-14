import type {
  BenchmarkEvaluationResult,
  BenchmarkFeedbackVisibility,
} from './contracts'

const MAX_FEEDBACK_BYTES = 8 * 1024
const FORBIDDEN_FEEDBACK_TERMS = [
  'fail_to_pass',
  'gold diff',
  'hidden test',
  'oracle patch',
  'pass_to_pass',
  'private spec',
  'test_patch',
]

export function createBenchmarkFeedback(input: {
  evaluation: BenchmarkEvaluationResult
  visibility: BenchmarkFeedbackVisibility
}): string {
  const publicPassed = input.evaluation.publicChecks.filter(
    (check) => check.passed,
  ).length
  const publicTotal = input.evaluation.publicChecks.length
  const lines = [
    'The initial benchmark attempt did not satisfy the task. Make one final repair and verify it.',
    publicTotal > 0
      ? `Public checks: ${publicPassed}/${publicTotal} passed.`
      : 'The patch could not be evaluated as submitted.',
  ]
  const failedPublic = input.evaluation.publicChecks
    .filter((check) => !check.passed)
    .map((check) => sanitizeLabel(check.title))
  if (failedPublic.length > 0) {
    lines.push(`Failed public checks: ${failedPublic.join(', ')}.`)
  }
  if (input.visibility === 'diagnostic') {
    const failedGroups = input.evaluation.groups
      .filter((group) => !group.passed)
      .map((group) => sanitizeLabel(group.title))
    if (failedGroups.length > 0) {
      lines.push(`Unresolved acceptance groups: ${failedGroups.join(', ')}.`)
    }
    lines.push(`Failure category: ${publicFailureCategory(input.evaluation)}.`)
  }
  const feedback = lines.join('\n')
  assertSafeFeedback(feedback)
  if (Buffer.byteLength(feedback, 'utf8') > MAX_FEEDBACK_BYTES) {
    throw new Error('Benchmark feedback exceeds its byte limit')
  }
  return feedback
}

export function assertSafeFeedback(feedback: string): void {
  const lowered = feedback.toLowerCase()
  if (FORBIDDEN_FEEDBACK_TERMS.some((term) => lowered.includes(term))) {
    throw new Error('Benchmark feedback contains evaluator-only terminology')
  }
  if (/\0|<benchmark_feedback>|<\/benchmark_feedback>/u.test(feedback)) {
    throw new Error('Benchmark feedback contains an unsafe control sequence')
  }
}

function sanitizeLabel(value: string): string {
  return value
    .replace(/[\r\n\0<>]/gu, ' ')
    .trim()
    .slice(0, 256)
}

function publicFailureCategory(evaluation: BenchmarkEvaluationResult): string {
  switch (evaluation.failureCategory) {
    case 'patch_invalid':
      return 'invalid patch'
    case 'setup_failed':
      return 'setup or build failure'
    case 'regression_failed':
      return 'public check failure'
    case 'acceptance_failed':
      return 'acceptance failure'
    case 'infrastructure_failed':
      return 'evaluation failure'
    case 'scope_violation':
    case 'patch_hygiene_failed':
      return 'invalid patch'
    default:
      return 'unresolved task'
  }
}
