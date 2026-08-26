import { describe, expect, it } from 'vitest'
import type { PublicConfig } from '../../shared/config'
import { resolveSwarmAvailability } from './session-swarm-availability'

function readyConfig(): {
  models: Pick<PublicConfig['models'], 'modelPool'>
} {
  return {
    models: {
      modelPool: {
        entries: [
          {
            id: 'reviewer',
            enabled: true,
            providerId: 'provider',
            model: 'review-model',
            reasoning: 'high',
          },
        ],
      },
    },
  }
}

describe('Swarm Tool availability', () => {
  it('exposes ordinary bounded Tool configuration without a slash-command goal', () => {
    expect(
      resolveSwarmAvailability({
        hostEnabled: true,
        runSubagentsEnabled: true,
        config: readyConfig(),
      }),
    ).toEqual({ toolConfig: {} })
  })

  it('retains an explicit slash-command goal only as display context', () => {
    expect(
      resolveSwarmAvailability({
        hostEnabled: true,
        runSubagentsEnabled: true,
        config: readyConfig(),
        requestedGoal: 'Review the repository',
      }),
    ).toEqual({
      toolConfig: {
        goal: 'Review the repository',
      },
    })
  })

  it.each([
    {
      name: 'unsupported host',
      patch: { hostEnabled: false },
      message: 'runtime host',
    },
    {
      name: 'disabled Subagents',
      patch: { runSubagentsEnabled: false },
      message: 'Subagents must be enabled',
    },
  ])('withholds Swarm for $name', ({ patch, message }) => {
    const result = resolveSwarmAvailability({
      hostEnabled: true,
      runSubagentsEnabled: true,
      config: readyConfig(),
      ...patch,
    })
    expect(result.toolConfig).toBeUndefined()
    expect(result.unavailableReason).toContain(message)
  })

  it('withholds Swarm without an enabled model-pool route', () => {
    const emptyPool = readyConfig()
    emptyPool.models.modelPool.entries[0]!.enabled = false
    expect(
      resolveSwarmAvailability({
        hostEnabled: true,
        runSubagentsEnabled: true,
        config: emptyPool,
      }).unavailableReason,
    ).toContain('model-pool route')
  })
})
