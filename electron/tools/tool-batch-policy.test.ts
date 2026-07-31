import { describe, expect, it } from 'vitest'
import { validateToolBatchPolicies } from './tool-batch-policy'

describe('Tool batch policy', () => {
  it('accepts a sole exclusive call and a final must-run-last call', () => {
    expect(
      validateToolBatchPolicies(1, [
        { index: 0, toolId: 'exclusive_tool', policy: 'exclusive' },
      ]),
    ).toBeUndefined()
    expect(
      validateToolBatchPolicies(2, [
        { index: 1, toolId: 'subagent_run', policy: 'must_run_last' },
      ]),
    ).toBeUndefined()
  })

  it('rejects misplaced, non-exclusive, and multiple special calls', () => {
    expect(
      validateToolBatchPolicies(2, [
        { index: 0, toolId: 'subagent_run', policy: 'must_run_last' },
      ]),
    ).toContain('last')
    expect(
      validateToolBatchPolicies(2, [
        { index: 0, toolId: 'exclusive_tool', policy: 'exclusive' },
      ]),
    ).toContain('only call')
    expect(
      validateToolBatchPolicies(3, [
        { index: 1, toolId: 'first', policy: 'must_run_last' },
        { index: 2, toolId: 'second', policy: 'must_run_last' },
      ]),
    ).toContain('at most one')
  })
})
