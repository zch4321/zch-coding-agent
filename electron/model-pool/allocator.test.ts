import { describe, expect, it } from 'vitest'
import type {
  ModelPoolCapability,
  ModelPoolEntry,
} from '../../shared/model-pool'
import { ModelPoolAllocationError, planModelPoolAssignments } from './allocator'

function entry(
  id: string,
  capability: ModelPoolCapability,
  overrides: Partial<ModelPoolEntry> = {},
): ModelPoolEntry {
  return {
    id,
    enabled: true,
    providerId: `provider-${id}`,
    model: `model-${id}`,
    reasoning: 'high',
    capability,
    maxParallel: 2,
    ...overrides,
  }
}

describe('planModelPoolAssignments', () => {
  it('round-robins ten requirements evenly across five same-tier entries', () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entry(`standard-${index + 1}`, 'standard'),
    )
    const assignments = planModelPoolAssignments(
      entries,
      Array<ModelPoolCapability>(10).fill('standard'),
    )

    expect(assignments.map((assignment) => assignment.entryId)).toEqual([
      'standard-1',
      'standard-2',
      'standard-3',
      'standard-4',
      'standard-5',
      'standard-1',
      'standard-2',
      'standard-3',
      'standard-4',
      'standard-5',
    ])
    expect(assignments.map((assignment) => assignment.maxParallel)).toEqual(
      Array(10).fill(2),
    )
  })

  it('preserves declaration order and resets every tier cursor per call', () => {
    const entries = [
      entry('third', 'light'),
      entry('first', 'light'),
      entry('second', 'light'),
    ]
    const requirements: ModelPoolCapability[] = ['light', 'light', 'light']

    const first = planModelPoolAssignments(entries, requirements)
    const second = planModelPoolAssignments(entries, requirements)

    expect(first.map((assignment) => assignment.entryId)).toEqual([
      'third',
      'first',
      'second',
    ])
    expect(second).toEqual(first)
  })

  it('chooses the lowest available satisfying tier for every requirement', () => {
    const entries = [entry('standard', 'standard'), entry('strong', 'strong')]

    expect(
      planModelPoolAssignments(entries, ['light', 'standard', 'strong']).map(
        (assignment) => ({
          requested: assignment.requestedCapability,
          assigned: assignment.capability,
          entryId: assignment.entryId,
        }),
      ),
    ).toEqual([
      { requested: 'light', assigned: 'standard', entryId: 'standard' },
      { requested: 'standard', assigned: 'standard', entryId: 'standard' },
      { requested: 'strong', assigned: 'strong', entryId: 'strong' },
    ])
  })

  it('never assigns a lower capability to a strong requirement', () => {
    expect(() =>
      planModelPoolAssignments(
        [entry('light', 'light'), entry('standard', 'standard')],
        ['strong'],
      ),
    ).toThrow(ModelPoolAllocationError)
  })

  it('ignores disabled entries during exact and upward matching', () => {
    const assignments = planModelPoolAssignments(
      [
        entry('disabled-light', 'light', { enabled: false }),
        entry('standard', 'standard'),
        entry('disabled-strong', 'strong', { enabled: false }),
      ],
      ['light'],
    )

    expect(assignments).toMatchObject([
      {
        entryId: 'standard',
        requestedCapability: 'light',
        capability: 'standard',
      },
    ])
  })

  it('fails the whole pure plan before returning partial assignments', () => {
    try {
      planModelPoolAssignments([entry('light', 'light')], ['light', 'strong'])
      throw new Error('expected allocation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelPoolAllocationError)
      expect(error).toMatchObject({
        requirementIndex: 1,
        capability: 'strong',
      })
    }
  })
})
