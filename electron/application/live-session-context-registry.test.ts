import { describe, expect, it, vi } from 'vitest'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import type { SessionManager } from '../session/session-manager'
import type { DurableExecutionStatePort } from './durable-execution-state-port'
import { LiveSessionContextRegistry } from './live-session-context-registry'
import type { ProjectService } from './project-service'
import type { SessionService } from './session-service'

function createRegistry() {
  const calls: string[] = []
  const manager = {
    hasActiveRun: vi.fn(() => false),
    hasMutationInProgress: vi.fn(() => false),
    hasUnsettledSideEffects: vi.fn(() => false),
    hasOpenTerminals: vi.fn(() => false),
    hasLiveSession: vi.fn(() => false),
    activeRunSnapshot: vi.fn(() => undefined),
    applyDurableSessionRecord: vi.fn(() => {
      calls.push('manager')
    }),
  } as unknown as SessionManager
  const executionState = {
    applyRecord: vi.fn(() => {
      calls.push('binding')
    }),
  } as unknown as DurableExecutionStatePort
  const registry = new LiveSessionContextRegistry({
    manager,
    sessions: {} as SessionService,
    projects: {} as ProjectService,
    executionState,
  })
  return { calls, executionState, manager, registry }
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

  it('rejects idle operations while runtime metadata is being committed', () => {
    const { manager, registry } = createRegistry()
    const sessionId = 'session:metadata-mutation' as SessionId
    vi.mocked(manager.hasMutationInProgress).mockReturnValue(true)

    expect(() => registry.assertSessionIdle(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() => registry.reserveSessionMutation(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() => registry.reserveSessionEviction(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('reserves lifecycle eviction while Terminals await quiescence', () => {
    const session = createRegistry()
    const sessionId = 'session:terminal-eviction' as SessionId
    const projectId = 'project:terminal-eviction' as ProjectId
    const owner = session.registry.reserveNew(
      sessionId,
      projectId,
      'request:terminal-eviction',
    )
    session.registry.adoptNew(sessionId, projectId, owner)
    vi.mocked(session.manager.hasOpenTerminals).mockReturnValue(true)

    expect(() => session.registry.assertSessionIdle(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() =>
      session.registry.reserveSessionEviction(sessionId),
    ).not.toThrow()

    const project = createRegistry()
    const projectOwner = project.registry.reserveNew(
      sessionId,
      projectId,
      'request:project-terminal-eviction',
    )
    project.registry.adoptNew(sessionId, projectId, projectOwner)
    vi.mocked(project.manager.hasOpenTerminals).mockReturnValue(true)

    expect(() => project.registry.assertProjectIdle(projectId)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() =>
      project.registry.reserveProjectEviction(projectId),
    ).not.toThrow()
  })

  it('applies runtime metadata before advancing the durable binding', () => {
    const { calls, manager, registry } = createRegistry()
    const sessionId = 'session:update-order' as SessionId
    const projectId = 'project:update-order' as ProjectId
    const ownerToken = registry.reserveNew(
      sessionId,
      projectId,
      'request:update-order',
    )
    registry.adoptNew(sessionId, projectId, ownerToken)
    vi.mocked(manager.hasLiveSession).mockReturnValue(true)
    const record = {
      id: sessionId,
      projectId,
    } as SessionRecord

    registry.applySessionRecord(record)

    expect(calls).toEqual(['manager', 'binding'])
  })

  it('waits for teardown before reloading an invalid Session', async () => {
    const sessionId = 'session:teardown' as SessionId
    const projectId = 'project:teardown' as ProjectId
    const record = {
      id: sessionId,
      projectId,
      lifecycle: 'active',
      revision: 1,
    } as SessionRecord
    let live = true
    let finishClose: (() => void) | undefined
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const manager = {
      hasLiveSession: vi.fn(() => live),
      closeSession: vi.fn(async () => {
        await closeGate
        live = false
        return true
      }),
      restoreSession: vi.fn(async () => {
        live = true
      }),
      hasActiveRun: vi.fn(() => false),
      hasMutationInProgress: vi.fn(() => false),
      hasUnsettledSideEffects: vi.fn(() => false),
      hasOpenTerminals: vi.fn(() => false),
      activeRunSnapshot: vi.fn(() => undefined),
    } as unknown as SessionManager
    const sessions = {
      loadRuntimeState: vi.fn(async () => ({
        record,
        activeHistory: [],
      })),
      getRecord: vi.fn(async () => record),
    } as unknown as SessionService
    const projects = {
      get: vi.fn(async () => ({ id: projectId, path: 'C:/workspace' })),
    } as unknown as ProjectService
    const executionState = {
      forget: vi.fn(),
      registerExisting: vi.fn(),
    } as unknown as DurableExecutionStatePort
    const registry = new LiveSessionContextRegistry({
      manager,
      sessions,
      projects,
      executionState,
    })
    const owner = registry.reserveNew(sessionId, projectId, 'request:teardown')
    registry.adoptNew(sessionId, projectId, owner)
    registry.invalidate(sessionId)

    const loading = registry.ensureLoaded(sessionId)
    await Promise.resolve()
    expect(sessions.loadRuntimeState).not.toHaveBeenCalled()
    finishClose?.()
    await loading

    expect(manager.closeSession).toHaveBeenCalledOnce()
    expect(sessions.loadRuntimeState).toHaveBeenCalledOnce()
    expect(manager.restoreSession).toHaveBeenCalledOnce()
  })
})
