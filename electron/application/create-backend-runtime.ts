import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppBootstrapResultSchema,
  DurableCommitEnvelope,
} from '../../shared/domain-state-api'
import type { Static } from '@sinclair/typebox'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import {
  DatabaseService,
  type DatabaseServiceOptions,
} from '../persistence/database-service'
import { MessageRepository } from '../persistence/message-repository'
import { FileChangeRepository } from '../persistence/file-change-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import { SubagentRepository } from '../persistence/subagent-repository'
import type { AutoApprover } from '../permission/auto-approver'
import type { ModelProvider } from '../providers/provider'
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
import { SubagentStateService } from './subagent-state-service'
import { AgentExecutionQueryService } from './agent-execution-query-service'
import { SubagentExecutionBridge } from '../subagent/execution-bridge'
import { SubagentExecutionService } from '../subagent/execution-service'

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
  onDiagnostic?: DiagnosticSink
}

export interface BackendRuntime {
  databasePath: string
  runtime: AgentRuntime
  coordinator: ApplicationStateCoordinator
  projects: ProjectService
  sessions: SessionService
  fileChanges: FileChangeService
  agentExecutions: AgentExecutionQueryService
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
  await rm(path.join(runtimeDataDirectory, 'subagent-snapshots'), {
    recursive: true,
    force: true,
  }).catch((error) =>
    options.onDiagnostic?.('Failed to clean legacy Subagent snapshots', error, {
      audience: 'internal',
    }),
  )
  const database = DatabaseService.open({
    databasePath,
    appVersion: options.appVersion ?? 'development',
    onMigrationProgress: (progress) => {
      const duration = Math.round(progress.elapsedMs)
      options.onDiagnostic?.(
        `SQLite migration ${progress.version}:${progress.name} ${progress.stage} (${duration}ms)`,
        undefined,
        { audience: 'internal' },
      )
    },
  })
  const listeners = new Set<(commit: DurableCommitEnvelope) => void>()
  const coordinator = new ApplicationStateCoordinator({
    database,
    publish: (commit) => {
      for (const listener of listeners) {
        try {
          listener(structuredClone(commit))
        } catch (error) {
          options.onDiagnostic?.('Durable commit listener failed', error, {
            audience: 'notification',
            code: 'DURABLE_PUBLICATION_FAILURE',
            message: 'A durable state update could not be published to the UI.',
          })
        }
      }
    },
    onDiagnostic: options.onDiagnostic,
  })
  const projectRepository = new ProjectRepository()
  const sessionRepository = new SessionRepository()
  const messageRepository = new MessageRepository()
  const fileChangeRepository = new FileChangeRepository()
  const subagentRepository = new SubagentRepository()

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
    traceCaptureStatus(sessionId) {
      return liveSessions?.traceCaptureStatus(sessionId)
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
  const subagentState = new SubagentStateService({
    coordinator,
    sessions: sessionRepository,
    messages: messageRepository,
    subagents: subagentRepository,
  })
  const executionState = new DurableExecutionStatePort(sessions, subagentState)
  const subagentBridge = new SubagentExecutionBridge()
  let runtime: AgentRuntime | undefined
  let subagentExecution: SubagentExecutionService | undefined

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
      subagentExecution: subagentBridge,
      onDiagnostic: options.onDiagnostic,
    })
    const agentExecutions = new AgentExecutionQueryService({
      coordinator,
      sessions: sessionRepository,
      messages: messageRepository,
      subagents: subagentRepository,
      liveSnapshot: (sessionId) =>
        runtime!.services.sessions.activeRunSnapshot(sessionId),
    })
    await subagentState.interruptActive()
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
    subagentExecution = new SubagentExecutionService({
      configStore: options.configStore,
      manager: runtime.services.sessions,
      sessions,
      executionState,
      state: subagentState,
      events: runtime.events,
      onDiagnostic: options.onDiagnostic,
    })
    subagentBridge.bind(subagentExecution)
    targetState.runs = runs
    let disposePromise: Promise<void> | undefined
    return {
      databasePath,
      runtime,
      coordinator,
      projects,
      sessions,
      fileChanges,
      agentExecutions,
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
      dispose() {
        disposePromise ??= disposeBackendRuntime({
          liveSessions,
          subagentExecution,
          runtime,
          coordinator,
          listeners,
          database,
        })
        return disposePromise
      },
    }
  } catch (error) {
    try {
      await settleCleanup([
        () => runtime?.dispose(),
        () => subagentExecution?.dispose(),
        () => coordinator.close(),
        () => database.close(),
      ])
    } catch (cleanupError) {
      try {
        options.onDiagnostic?.('Backend startup cleanup failed', cleanupError)
      } catch {
        // Diagnostics must not replace the original startup failure.
      }
    }
    throw error
  }
}

async function disposeBackendRuntime(input: {
  liveSessions?: LiveSessionContextRegistry
  subagentExecution?: SubagentExecutionService
  runtime?: AgentRuntime
  coordinator: ApplicationStateCoordinator
  listeners: Set<(commit: DurableCommitEnvelope) => void>
  database: DatabaseService
}): Promise<void> {
  await settleCleanup([
    () => input.liveSessions?.dispose(),
    () => input.subagentExecution?.dispose(),
    () => input.runtime?.dispose(),
    () => input.coordinator.close(),
    () => input.listeners.clear(),
    () => input.database.close(),
  ])
}

async function settleCleanup(
  actions: ReadonlyArray<() => unknown | Promise<unknown>>,
): Promise<void> {
  let failure: unknown
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

export type { AutoApprover, DatabaseServiceOptions, ModelProvider }
