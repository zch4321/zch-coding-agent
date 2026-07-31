import type { ToolBatchPolicy } from './types'

export interface SpecialToolBatchEntry {
  index: number
  toolId: string
  policy: Exclude<ToolBatchPolicy, 'normal'>
}

/** Validates special-position policies before any call in a Tool batch executes. */
export function validateToolBatchPolicies(
  batchLength: number,
  special: readonly SpecialToolBatchEntry[],
): string | undefined {
  if (special.length > 1) {
    return 'A tool batch may contain at most one special-position tool'
  }
  const entry = special[0]
  if (!entry) return undefined
  if (entry.policy === 'exclusive' && batchLength !== 1) {
    return `${entry.toolId} must be the only call in its tool batch`
  }
  if (entry.policy === 'must_run_last' && entry.index !== batchLength - 1) {
    return `${entry.toolId} must be the last call in its tool batch`
  }
  return undefined
}
