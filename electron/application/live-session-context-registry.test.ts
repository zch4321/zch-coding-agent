import { describe, expect, it, vi } from 'vitest'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { SessionManager } from '../session/session-manager'
import type { DurableExecutionStatePort } from './durable-execution-state-port'
import { LiveSessionContextRegistry } from './live-session-context-registry'
import type { ProjectService } from './project-service'
import type { SessionService } from './session-service'

function createRegistry() {
  const manager = {
    hasActiveRun: vi.fn(() => false),
    hasUnsettledSideEffects: vi.fn(() => false),
    hasOpenTerminals: vi.fn(() => false),
    hasLiveSession: vi.fn(() => false),
    activeRunSnapshot: vi.fn(() => undefined),
  } as unknown as SessionManager
  const registry = new LiveSessionContextRegistry({
    manager,
    sessions: {} as SessionService,
    projects: {} as ProjectService,
    executionState: {} as DurableExecutionStatePort,
  })
  return { manager, registry }
}

describe('LiveSessionContextRegistry mutation ownership', () => {
  it('blocks load, archive and project eviction throughout a mutation window', async () => {
    const { registry } = createRegistry()
    const sessionId = 'session:mutating' as SessionId
    const projectId = 'project:mutating' as ProjectId
    const token = registry.reserveSessionMutation(sessionId)

    await expect(registry.ensureLoaded(sessionId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(() => registry.assertSessionIdle(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() => registry.reserveSessionEviction(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() => registry.assertProjectIdle(projectId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )

    registry.bindSessionMutationProject(sessionId, token, projectId)
    expect(() => registry.assertProjectIdle(projectId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    registry.releaseSessionMutation(sessionId, token)
    expect(() => registry.assertSessionIdle(sessionId)).not.toThrow()
    expect(() => registry.assertProjectIdle(projectId)).not.toThrow()
  })

  it('rejects mutation reservation while a run or side effect is active', () => {
    const { manager, registry } = createRegistry()
    vi.mocked(manager.hasActiveRun).mockReturnValueOnce(true)
    expect(() =>
      registry.reserveSessionMutation('session:run' as SessionId),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))

    vi.mocked(manager.hasUnsettledSideEffects).mockReturnValueOnce(true)
    expect(() =>
      registry.reserveSessionMutation('session:side-effect' as SessionId),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
  })
})
