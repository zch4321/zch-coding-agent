import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppBootstrapResultSchema,
  DurableCommitEnvelope,
} from '../../shared/domain-state-api'
import type { Static } from '@sinclair/typebox'
import type { ConfigStore } from '../config/store'
import {
  DatabaseService,
  type DatabaseServiceOptions,
} from '../persistence/database-service'
import { MessageRepository } from '../persistence/message-repository'
import { FileChangeRepository } from '../persistence/file-change-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import type { AutoApprover } from '../permission/auto-approver'
import type { LLMProvider } from '../providers/provider'
import {
  createAgentRuntime,
  type CreateAgentRuntimeOptions,
} from '../runtime/create-agent-runtime'
import type { AgentRuntime } from '../runtime/agent-runtime'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { FileChangeService } from './file-change-service'
import { DurableExecutionStatePort } from './durable-execution-state-port'
import { DurableRunApplicationService } from './durable-run-application-service'
import { LiveSessionContextRegistry } from './live-session-context-registry'
import { ProjectService, type ProjectRuntimeGuard } from './project-service'
import { SessionService, type SessionRuntimeGuard } from './session-service'

type AppBootstrapResult = Static<typeof AppBootstrapResultSchema>

export interface CreateBackendRuntimeOptions {
  configStore: ConfigStore
  promptDirectory: string
  databasePath: string
  runtimeDataDirectory: string
  appVersion?: string
  fetchImpl?: typeof fetch
  providerFactory?: CreateAgentRuntimeOptions['providerFactory']
  autoApproverFactory?: CreateAgentRuntimeOptions['autoApproverFactory']
  eventListeners?: CreateAgentRuntimeOptions['eventListeners']
  onDiagnostic?: (message: string, error?: unknown) => void
}

export interface BackendRuntime {
  databasePath: string
  runtime: AgentRuntime
  coordinator: ApplicationStateCoordinator
  projects: ProjectService
  sessions: SessionService
  fileChanges: FileChangeService
  runs: DurableRunApplicationService
  liveSessions: LiveSessionContextRegistry
  bootstrap(): Promise<AppBootstrapResult>
  subscribe(listener: (commit: DurableCommitEnvelope) => void): () => void
  dispose(): Promise<void>
}

/** Creates the sole production backend composition against SQLite. */
export async function createBackendRuntime(
  options: CreateBackendRuntimeOptions,
): Promise<BackendRuntime> {
  const databasePath = path.resolve(options.databasePath)
  const runtimeDataDirectory = path.resolve(options.runtimeDataDirectory)
  await mkdir(path.dirname(databasePath), { recursive: true })
  await mkdir(runtimeDataDirectory, { recursive: true })
  const database = DatabaseService.open({
    databasePath,
    appVersion: options.appVersion ?? 'development',
  })
  const listeners = new Set<(commit: DurableCommitEnvelope) => void>()
  const coordinator = new ApplicationStateCoordinator({
    database,
    publish: (commit) => {
      for (const listener of listeners) listener(structuredClone(commit))
    },
    onDiagnostic: options.onDiagnostic,
  })
  const projectRepository = new ProjectRepository()
  const sessionRepository = new SessionRepository()
  const messageRepository = new MessageRepository()
  const fileChangeRepository = new FileChangeRepository()

  let liveSessions: LiveSessionContextRegistry | undefined
  const projectGuard: ProjectRuntimeGuard = {
    assertProjectIdle(projectId) {
      liveSessions?.assertProjectIdle(projectId)
    },
    evictIdleProject(projectId, operationToken) {
      return liveSessions?.evictIdleProject(projectId, operationToken)
    },
    reserveProjectEviction(projectId) {
      if (!liveSessions) {
        throw new Error('Live Session registry is not initialized')
      }
      return liveSessions.reserveProjectEviction(projectId)
    },
    cancelProjectEviction(projectId, token) {
      liveSessions?.cancelProjectEviction(projectId, token)
    },
  }
  const sessionGuard: SessionRuntimeGuard = {
    assertSessionIdle(sessionId) {
      liveSessions?.assertSessionIdle(sessionId)
    },
    snapshot(sessionId) {
      return liveSessions?.snapshot(sessionId)
    },
    reserveSessionEviction(sessionId) {
      if (!liveSessions) {
        throw new Error('Live Session registry is not initialized')
      }
      return liveSessions.reserveSessionEviction(sessionId)
    },
    cancelSessionEviction(sessionId, token) {
      liveSessions?.cancelSessionEviction(sessionId, token)
    },
    releaseSession(sessionId, operationToken) {
      return liveSessions?.releaseSession(sessionId, operationToken)
    },
    applySessionRecord(record) {
      return liveSessions?.applySessionRecord(record)
    },
  }
  const projects = new ProjectService({
    coordinator,
    repository: projectRepository,
    runtimeGuard: projectGuard,
    onDiagnostic: options.onDiagnostic,
  })
  const sessions = new SessionService({
    coordinator,
    sessions: sessionRepository,
    messages: messageRepository,
    runtimeGuard: sessionGuard,
    onDiagnostic: options.onDiagnostic,
  })
  const fileChanges = new FileChangeService({
    coordinator,
    fileChanges: fileChangeRepository,
    sessions: sessionRepository,
    projects: projectRepository,
    onDiagnostic: options.onDiagnostic,
  })
  const executionState = new DurableExecutionStatePort(sessions)
  let runtime: AgentRuntime | undefined

  try {
    runtime = await createAgentRuntime({
      configStore: options.configStore,
      userDataDirectory: runtimeDataDirectory,
      promptDirectory: options.promptDirectory,
      fetchImpl: options.fetchImpl,
      providerFactory: options.providerFactory,
      autoApproverFactory: options.autoApproverFactory,
      eventListeners: options.eventListeners,
      executionState,
      fileChangeExecution: fileChanges,
      onDiagnostic: options.onDiagnostic,
    })
    const targetState: { runs?: DurableRunApplicationService } = {}
    liveSessions = new LiveSessionContextRegistry({
      manager: runtime.services.sessions,
      projects,
      sessions,
      executionState,
      onSessionEvicted: (sessionId) =>
        targetState.runs?.evictRequestCacheForSession(sessionId),
      onDiagnostic: options.onDiagnostic,
    })
    fileChanges.setRuntimeGuard({
      reserveSessionMutation: (sessionId) =>
        liveSessions!.reserveSessionMutation(sessionId),
      bindSessionMutationProject: (sessionId, token, projectId) =>
        liveSessions!.bindSessionMutationProject(sessionId, token, projectId),
      releaseSessionMutation: (sessionId, token) =>
        liveSessions!.releaseSessionMutation(sessionId, token),
      acquireFileChangeRevertWriter: (input) =>
        runtime!.services.sessions.acquireFileChangeRevertWriter(input),
    })
    executionState.setInvalidationHandler((sessionId, runId) =>
      liveSessions?.invalidate(sessionId, runId),
    )
    const runs = new DurableRunApplicationService({
      manager: runtime.services.sessions,
      projects,
      sessions,
      registry: liveSessions,
      executionState,
    })
    targetState.runs = runs
    let disposed = false
    return {
      databasePath,
      runtime,
      coordinator,
      projects,
      sessions,
      fileChanges,
      runs,
      liveSessions,
      async bootstrap() {
        const snapshot = await coordinator.query((reader) => ({
          projects: projectRepository.list(reader),
          sessionPage: sessionRepository.listPage(reader, {
            lifecycle: 'active',
            limit: 200,
          }),
        }))
        return {
          version: 1,
          cursor: snapshot.cursor,
          projects: snapshot.value.projects,
          sessionPage: snapshot.value.sessionPage,
        }
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async dispose() {
        if (disposed) return
        disposed = true
        listeners.clear()
        await liveSessions?.dispose()
        await runtime?.dispose()
        await database.close()
      },
    }
  } catch (error) {
    await runtime?.dispose()
    await database.close()
    throw error
  }
}

export type { AutoApprover, DatabaseServiceOptions, LLMProvider }
