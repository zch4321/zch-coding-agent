import {
  BrowserWindow,
  dialog,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { fileStatus as stat } from '../common/filesystem'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'
import {
  fetchProviderModelCatalog,
  ModelCatalogError,
  modelCatalogEndpoint,
  resolveModelProfiles,
} from '../providers/model-catalog'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import type { ConfigStore } from '../config/store'
import { SkillError, type SkillsManager } from '../skills/manager'
import { TraceServiceError, type TraceService } from '../logging/service'
import { writeTextAtomic } from '../config/atomic-file'
import type { HttpTransport } from '../net/http-transport'
import type { McpManager } from '../mcp/mcp-manager'
import type { BackendRuntime } from '../application/create-backend-runtime'
import { IpcFault, type IpcBusinessHandlers } from './index'
import { renderConversationTranscript } from '../session/conversation-transcript'
import {
  commandShellService,
  type CommandShellService,
} from '../process/command-shell'
import type { OperationalLogService } from '../operational-logging/service'
import { ProviderAttemptRecorder } from '../operational-logging/provider-attempt-recorder'

export interface AppIpcHandlerDependencies {
  configStore: ConfigStore
  backend: BackendRuntime
  skillsManager: SkillsManager
  traceService: TraceService
  operationalLog: OperationalLogService
  commandShells?: Pick<CommandShellService, 'catalog'>
  mcpManager?: McpManager
  getHttpTransport?: () => HttpTransport
  refreshHttpTransport?: (
    proxy: ReturnType<ConfigStore['getPublicConfig']>['network']['httpProxy'],
  ) => void
  getMainWindow: () => BrowserWindow | undefined
}

function traceFault(error: unknown): IpcFault | undefined {
  if (!(error instanceof TraceServiceError)) return undefined
  return new IpcFault({
    code:
      error.code === 'TRACE_NOT_FOUND' ||
      error.code === 'TRACE_REQUEST_NOT_FOUND'
        ? 'NOT_FOUND'
        : 'PRECONDITION_FAILED',
    message: error.message,
    details: { traceCode: error.code },
  })
}

function notAvailable(message: string): IpcFault {
  return new IpcFault({ code: 'NOT_AVAILABLE', message })
}

/** Builds validated IPC business handlers around configuration, project, session, and runtime services. */
export function createAppIpcHandlers(
  dependencies: AppIpcHandlerDependencies,
): IpcBusinessHandlers {
  const {
    configStore,
    backend,
    skillsManager,
    traceService,
    operationalLog,
    commandShells = commandShellService,
    mcpManager,
    getHttpTransport,
    refreshHttpTransport,
    getMainWindow,
  } = dependencies
  const sessionManager = backend.runtime.services.sessions

  const projectWorkspace = async (
    projectId: Parameters<typeof backend.projects.get>[0],
  ) => (await backend.projects.get(projectId)).path

  return {
    'background:list': (payload) => backend.backgroundTasks.list(payload),
    'background:cancel': (payload) => backend.backgroundTasks.cancel(payload),
    'background:terminal-tail': (payload) =>
      backend.backgroundTasks.tail(payload),
    'config:get': (payload) => ({
      section: payload.section,
      config: configStore.getPublicConfig(),
    }),
    'config:set': async (payload) => {
      if (
        payload.kind === 'logging' &&
        payload.value.trace.enabled &&
        configStore.getPublicConfig().privacy.traceNoticeAccepted?.version !==
          TRACE_NOTICE_VERSION
      ) {
        throw new IpcFault({
          code: 'PRECONDITION_FAILED',
          message:
            'Trace logging notice must be accepted before enabling full trace logs',
          details: { requiredVersion: TRACE_NOTICE_VERSION },
        })
      }

      const config = await configStore.update(payload)
      let warnings: string[] = []
      if (payload.kind === 'logging') {
        operationalLog.reconfigure(config.logging.operational)
        warnings = await sessionManager.reconfigureTraceLogging(
          config.logging.trace.enabled,
        )
      }

      if (payload.kind === 'network') {
        refreshHttpTransport?.(config.network.httpProxy)
      }

      return { config, ...(warnings.length > 0 ? { warnings } : {}) }
    },
    'command-shell:list': (payload) =>
      commandShells.catalog(
        configStore.getPublicConfig().executionEnvironment.commandShell,
        payload.refresh ?? false,
      ),
    'mcp:list': () => ({ servers: mcpManager?.listStatuses() ?? [] }),
    'mcp:reload': async () => {
      if (!mcpManager) throw notAvailable('MCP manager is unavailable')
      return { servers: await mcpManager.reload() }
    },
    'mcp:trust-enable': async (payload) => {
      if (!mcpManager) throw notAvailable('MCP manager is unavailable')
      return {
        servers: await mcpManager.trustAndEnable(
          payload.serverId,
          payload.fingerprint,
        ),
      }
    },
    'mcp:disable': async (payload) => {
      if (!mcpManager) throw notAvailable('MCP manager is unavailable')
      return { servers: await mcpManager.disable(payload.serverId) }
    },
    'mcp:restart': async (payload) => {
      if (!mcpManager) throw notAvailable('MCP manager is unavailable')
      return {
        servers: await mcpManager.restart(payload.serverId, payload.workspace),
      }
    },
    'provider:list-models': async (payload) => {
      const config = configStore.getPublicConfig()
      const provider = config.models.providers.find(
        (candidate) =>
          candidate.id ===
          (payload.providerId ?? config.models.defaultModelProvider),
      )

      if (!provider) {
        throw new IpcFault({
          code: 'PRECONDITION_FAILED',
          message: 'Active provider is not configured',
        })
      }

      if (payload.refresh) {
        const apiKey = await configStore.getProviderApiKey(provider.id)

        if (!apiKey) {
          throw new IpcFault({
            code: 'PRECONDITION_FAILED',
            message: `Save a ${provider.label} credential before refreshing models`,
          })
        }

        const catalogAttempt = new ProviderAttemptRecorder(operationalLog, {
          operation: 'model_catalog',
          providerCallId: `catalog:${provider.id}:${Date.now()}`,
          providerId: provider.id,
          providerType: provider.providerType,
          model: provider.model,
          endpoint: modelCatalogEndpoint(provider.baseURL),
          messageCount: 0,
          toolCount: 0,
        })
        try {
          const models = await fetchProviderModelCatalog({
            providerType: provider.providerType,
            baseURL: provider.baseURL,
            apiKey,
            timeoutMs: config.limits.modelCatalogTimeoutMs,
            fetchImpl: getHttpTransport
              ? (input, init) => getHttpTransport().fetch(input, init)
              : undefined,
          })
          await configStore.setProviderModelCatalog(
            provider.id,
            models,
            new Date().toISOString(),
          )
          catalogAttempt.completed()
        } catch (error) {
          catalogAttempt.failed(error, {
            code: 'PROVIDER_MODEL_CATALOG_FAILED',
            ...(error instanceof ModelCatalogError && error.status !== undefined
              ? { httpStatus: error.status }
              : {}),
          })
          if (error instanceof ModelCatalogError) {
            throw new IpcFault({
              code:
                error.status === 401 || error.status === 403
                  ? 'PRECONDITION_FAILED'
                  : 'NOT_AVAILABLE',
              message:
                error.status === 401 || error.status === 403
                  ? `${provider.label} rejected the configured credential`
                  : error.status === 404 || error.status === 405
                    ? `${provider.label} does not expose a model catalog; add models manually`
                    : error.message,
            })
          }

          throw error
        }
      }

      const latestConfig = configStore.getPublicConfig()
      const latestProvider =
        latestConfig.models.providers.find(
          (candidate) =>
            candidate.id ===
            (payload.providerId ?? latestConfig.models.defaultModelProvider),
        ) ?? latestConfig.models.providers[0]
      const fetchedAt = latestProvider.modelCatalogFetchedAt
      const stale =
        !fetchedAt ||
        Date.now() - new Date(fetchedAt).getTime() > 24 * 60 * 60_000

      return {
        models: resolveModelProfiles(latestConfig, latestProvider.id),
        fetchedAt,
        stale,
      }
    },
    'app:get-bootstrap': () => backend.bootstrap(),
    'project:list': async () => ({
      version: 1,
      projects: await backend.projects.list(),
    }),
    'project:add': (payload) =>
      backend.projects.add({ path: payload.path, name: payload.name }),
    'project:update': (payload) =>
      backend.projects.update({
        projectId: payload.projectId,
        expectedRevision: payload.expectedRevision,
        patch: payload.patch,
      }),
    'project:remove': (payload) =>
      backend.projects.remove({
        projectId: payload.projectId,
        expectedRevision: payload.expectedRevision,
      }),
    'session:list': async (payload) => ({
      version: 1,
      page: await backend.sessions.list({
        projectId: payload.projectId,
        lifecycle: payload.lifecycle,
        search: payload.search,
        before: payload.before,
        limit: payload.limit,
      }),
    }),
    'session:get': async (payload) => ({
      version: 1,
      snapshot: await backend.sessions.get(payload.sessionId),
    }),
    'session:update': (payload) =>
      backend.sessions.update({
        sessionId: payload.sessionId,
        expectedRevision: payload.expectedRevision,
        patch: payload.patch,
      }),
    'session:archive': (payload) =>
      backend.sessions.archive({
        sessionId: payload.sessionId,
        expectedRevision: payload.expectedRevision,
      }),
    'session:restore': (payload) =>
      backend.sessions.restore({
        sessionId: payload.sessionId,
        expectedRevision: payload.expectedRevision,
      }),
    'session:delete': (payload) =>
      backend.sessions.deleteArchived({
        sessionId: payload.sessionId,
        expectedRevision: payload.expectedRevision,
      }),
    'session:export-markdown': async (payload) => {
      const session = await backend.sessions.getRecord(payload.sessionId)
      const records = await backend.sessions.listAllMessages(payload.sessionId)
      const document = renderConversationTranscript(records, {
        mode: 'export',
        sessionId: session.id,
        title: session.title,
        exportedAt: new Date().toISOString(),
      })
      const suggested = `${session.title}-conversation.md`.replace(
        /[\\/:*?"<>|]/gu,
        '_',
      )
      const options: SaveDialogOptions = {
        defaultPath: suggested,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }
      const mainWindow = getMainWindow()
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      await writeTextAtomic(result.filePath, document.markdown)
      return { canceled: false, path: result.filePath }
    },
    'session:fork': (payload) =>
      backend.sessions.fork({
        sourceSessionId: payload.sourceSessionId,
        expectedRevision: payload.expectedRevision,
        sessionId: payload.sessionId,
        throughMessageId: payload.throughMessageId,
        title: payload.title,
      }),
    'session:rewind': (payload) =>
      backend.sessions.rewind({
        sessionId: payload.sessionId,
        expectedRevision: payload.expectedRevision,
        messageId: payload.messageId,
        boundary: payload.boundary,
      }),
    'session:search': async (payload) => ({
      version: 1,
      hits: await backend.sessions.searchSessions({
        text: payload.text,
        projectId: payload.projectId,
        limit: payload.limit,
      }),
    }),
    'message:list': async (payload) => ({
      version: 1,
      page: await backend.sessions.listMessages(payload.sessionId, {
        beforeSeq: payload.beforeSeq,
        limit: payload.limit,
      }),
    }),
    'message:search': async (payload) => ({
      version: 1,
      records: await backend.sessions.searchMessages(payload.sessionId, {
        text: payload.text,
        limit: payload.limit,
      }),
    }),
    'git-review:get-status': async (payload) =>
      backend.gitReview.getStatus(await projectWorkspace(payload.projectId)),
    'git-review:get-diff': async (payload) =>
      backend.gitReview.getDiff({
        workspace: await projectWorkspace(payload.projectId),
        mode: payload.mode,
        path: payload.path,
        baseRef: payload.baseRef,
        contextLines: payload.contextLines,
      }),
    'agent-execution:list': async (payload) => ({
      page: await backend.agentExecutions.list({
        parentSessionId: payload.parentSessionId,
        ...(payload.before ? { before: payload.before } : {}),
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      }),
    }),
    'agent-execution:get': async (payload) => ({
      detail: await backend.agentExecutions.get({
        parentSessionId: payload.parentSessionId,
        executionId: payload.executionId,
        ...(payload.beforeSeq === undefined
          ? {}
          : { beforeSeq: payload.beforeSeq }),
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      }),
    }),
    'agent-execution:approval-decide': (payload) => ({
      accepted: sessionManager.decideAgentExecutionApproval({
        parentSessionId: payload.parentSessionId,
        executionId: payload.executionId,
        callId: payload.callId,
        decision: payload.decision,
        remember: payload.remember,
      }),
    }),
    'workspace:choose': async () => {
      const options: OpenDialogOptions = {
        properties: ['openDirectory'],
      }
      const mainWindow = getMainWindow()
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      const selected = result.canceled ? null : result.filePaths[0]

      if (selected) {
        await configStore.update({
          version: 1,
          kind: 'workspace',
          lastOpened: selected,
        })
      }

      return { path: selected ?? null }
    },
    'workspace:list-directory': async (payload) => {
      const workspace = await projectWorkspace(payload.projectId)

      try {
        const guard = await PathGuard.create(workspace)
        const entries = await guard.listDirectory(payload.path ?? '.')
        const visible = entries
          .filter(
            (entry) => entry.type === 'file' || entry.type === 'directory',
          )
          .sort((left, right) => {
            if (left.type !== right.type) {
              return left.type === 'directory' ? -1 : 1
            }

            return left.name.localeCompare(right.name)
          })
        const limited = visible.slice(0, 1_000)

        return {
          workspace,
          path: payload.path ?? '.',
          entries: limited,
          truncated: visible.length > limited.length,
        }
      } catch (error) {
        if (error instanceof PathGuardError) {
          throw new IpcFault({
            code:
              error.code === 'PATH_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'workspace:read-file': async (payload) => {
      const workspace = await projectWorkspace(payload.projectId)

      try {
        const guard = await PathGuard.create(workspace)
        const maxBytes = Math.min(
          configStore.getPublicConfig().limits.maxToolOutputBytes,
          499_999,
        )
        return {
          workspace,
          ...(await guard.readFileBounded(payload.path, maxBytes)),
        }
      } catch (error) {
        if (error instanceof PathGuardError) {
          throw new IpcFault({
            code:
              error.code === 'PATH_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'workspace:open-file': async (payload) => {
      const workspace = await projectWorkspace(payload.projectId)

      try {
        const guard = await PathGuard.create(workspace)
        const guarded = await guard.resolveExisting(payload.path)
        const fileStat = await stat(guarded.realPath)

        if (!fileStat.isFile()) {
          throw new PathGuardError('NOT_A_FILE', 'Path is not a regular file')
        }

        const openError = await shell.openPath(guarded.realPath)
        if (openError) {
          throw new IpcFault({
            code: 'NOT_AVAILABLE',
            message: 'No external application could open this file',
          })
        }

        return { path: guarded.relativePath }
      } catch (error) {
        if (error instanceof PathGuardError) {
          throw new IpcFault({
            code:
              error.code === 'PATH_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'workspace:choose-context': async (payload) => {
      const workspace = await projectWorkspace(payload.projectId)
      const options: OpenDialogOptions = {
        defaultPath: workspace,
        properties:
          payload.kind === 'directory'
            ? ['openDirectory', 'multiSelections']
            : ['openFile', 'multiSelections'],
      }
      const mainWindow = getMainWindow()
      const selected = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)

      if (selected.canceled) {
        return { attachments: [] }
      }

      try {
        const guard = await PathGuard.create(workspace)
        const attachments = await Promise.all(
          selected.filePaths.slice(0, 32).map(async (filePath) => {
            const guarded = await guard.resolveExisting(filePath)
            const fileStat = await stat(guarded.realPath)

            if (payload.kind === 'file' && !fileStat.isFile()) {
              throw new PathGuardError('NOT_A_FILE', 'Path is not a file')
            }

            if (payload.kind === 'directory' && !fileStat.isDirectory()) {
              throw new PathGuardError(
                'NOT_A_DIRECTORY',
                'Path is not a directory',
              )
            }

            return {
              kind: payload.kind,
              path: guarded.relativePath,
              source: 'picker' as const,
              ...(payload.kind === 'file'
                ? { totalBytes: fileStat.size, truncated: false }
                : {}),
            }
          }),
        )

        return { attachments }
      } catch (error) {
        if (error instanceof PathGuardError) {
          throw new IpcFault({
            code:
              error.code === 'PATH_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'project:get': async () => {
      throw notAvailable(
        'Project metadata is temporarily disabled pending SQLite migration',
      )
    },
    'project:save': async () => {
      throw notAvailable(
        'Project metadata is temporarily disabled pending SQLite migration',
      )
    },
    'project:detect-modules': async () => {
      throw notAvailable(
        'Project metadata is temporarily disabled pending SQLite migration',
      )
    },
    'project:backend-status': async () => {
      throw notAvailable(
        'Code intelligence is temporarily disabled pending SQLite migration',
      )
    },
    'project:restart-backend': async () => {
      throw notAvailable(
        'Code intelligence is temporarily disabled pending SQLite migration',
      )
    },
    'plan:update-status': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return sessionManager.updatePlanStatus({
        sessionId: payload.sessionId,
        status: payload.status,
      })
    },
    'run:start': (payload) => backend.runs.start(payload),
    'run:retry': (payload) => backend.runs.retry(payload),
    'run:continue': (payload) => backend.runs.continue(payload),
    'run:interrupt': (payload) => ({
      accepted: sessionManager.interruptRun(payload.sessionId, payload.runId),
    }),
    'run:interject': (payload) => ({
      accepted: sessionManager.interjectRun({
        sessionId: payload.sessionId,
        runId: payload.runId,
        message: payload.message,
        clientRequestId: payload.clientRequestId,
      }),
    }),
    'approval:decide': (payload) => ({
      accepted: sessionManager.decideApproval({
        sessionId: payload.sessionId,
        runId: payload.runId,
        callId: payload.callId,
        decision: payload.decision,
        remember: payload.remember,
      }),
    }),
    'terminal:open': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return {
        terminal: await sessionManager.openTerminal({
          sessionId: payload.sessionId,
          cwd: payload.cwd,
          cols: payload.cols,
          rows: payload.rows,
        }),
      }
    },
    'terminal:list': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return {
        terminals: sessionManager.listTerminals(payload.sessionId),
      }
    },
    'terminal:input': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return {
        accepted: sessionManager.sendTerminalInput(
          payload.sessionId,
          payload.terminalId,
          payload.data,
        ),
      }
    },
    'terminal:resize': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return {
        accepted: sessionManager.resizeTerminal(
          payload.sessionId,
          payload.terminalId,
          payload.cols,
          payload.rows,
        ),
      }
    },
    'terminal:close': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return {
        accepted: sessionManager.closeTerminal(
          payload.sessionId,
          payload.terminalId,
        ),
      }
    },
    'terminal:snapshot': async (payload) => {
      await backend.liveSessions.ensureLoaded(payload.sessionId)
      return sessionManager.terminalSnapshot(
        payload.sessionId,
        payload.terminalId,
      )
    },
    'window:minimize': (_payload, event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize()
      return { accepted: true }
    },
    'window:toggle-maximize': (_payload, event) => {
      const window = BrowserWindow.fromWebContents(event.sender)

      if (window?.isMaximized()) {
        window.unmaximize()
      } else {
        window?.maximize()
      }

      return { accepted: true }
    },
    'window:close': (_payload, event) => {
      BrowserWindow.fromWebContents(event.sender)?.close()
      return { accepted: true }
    },
    'skills:list': () => skillsManager.list(),
    'skills:installFromUrl': async (payload) => {
      try {
        return {
          installed: true,
          skill: await skillsManager.installFromUrl(payload.url),
        }
      } catch (error) {
        if (error instanceof SkillError) {
          throw new IpcFault({
            code:
              error.code === 'DUPLICATE_NAME'
                ? 'CONFLICT'
                : 'PRECONDITION_FAILED',
            message: error.message,
            details: { skillCode: error.code },
          })
        }

        throw error
      }
    },
    'skills:chooseAndInstallFile': async () => {
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'Markdown skills', extensions: ['md'] }],
      }
      const mainWindow = getMainWindow()
      const selected = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)

      if (selected.canceled || !selected.filePaths[0]) {
        return { installed: false }
      }

      try {
        return {
          installed: true,
          skill: await skillsManager.installFromFile(selected.filePaths[0]),
        }
      } catch (error) {
        if (error instanceof SkillError) {
          throw new IpcFault({
            code:
              error.code === 'DUPLICATE_NAME'
                ? 'CONFLICT'
                : 'PRECONDITION_FAILED',
            message: error.message,
            details: { skillCode: error.code },
          })
        }

        throw error
      }
    },
    'skills:refresh': () => skillsManager.refresh(),
    'skills:setEnabled': async (payload) => ({
      updated: await skillsManager.setEnabled(payload.name, payload.enabled),
    }),
    'trace:list': () => traceService.list(),
    'trace:replay': async (payload) => {
      try {
        return await traceService.replay(payload.traceId)
      } catch (error) {
        const fault = traceFault(error)
        if (fault) throw fault
        throw error
      }
    },
    'trace:transcript-page': async (payload) => {
      try {
        return await traceService.transcriptPage(payload)
      } catch (error) {
        const fault = traceFault(error)
        if (fault) throw fault
        throw error
      }
    },
    'trace:request-messages': async (payload) => {
      try {
        return await traceService.transcriptRequestMessages(payload)
      } catch (error) {
        const fault = traceFault(error)
        if (fault) throw fault
        throw error
      }
    },
    'trace:export-transcript': async (payload) => {
      const mainWindow = getMainWindow()

      try {
        const document = await traceService.transcriptDocument(payload.traceId)
        const suggested = `${
          document.metadata.sessionId ?? payload.traceId
        }-session-transcript.md`.replace(/[\\/:*?"<>|]/gu, '_')
        const options: SaveDialogOptions = {
          defaultPath: suggested,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        }
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { canceled: true }
        await writeTextAtomic(
          result.filePath,
          await traceService.transcriptMarkdown(payload.traceId),
        )
        return { canceled: false, path: result.filePath }
      } catch (error) {
        const fault = traceFault(error)
        if (fault) throw fault
        throw error
      }
    },
    'trace:stats': (payload) => traceService.stats(payload.traceId),
    'logs:open-directory': async () => {
      await traceService.initialize()
      const error = await shell.openPath(traceService.directory)

      if (error) {
        throw new IpcFault({ code: 'NOT_AVAILABLE', message: error })
      }

      return { accepted: true }
    },
    'logs:clear-closed': async () => ({
      deleted: await traceService.clearClosed(sessionManager.activeTraceIds()),
    }),
    'runtime-log:status': () => {
      const status = operationalLog.status()
      return {
        enabled: status.enabled,
        level: status.level,
        degraded: status.degraded,
        ...(status.warning ? { warning: status.warning } : {}),
      }
    },
    'runtime-log:open-directory': async () => {
      await operationalLog.cleanup()
      const error = await shell.openPath(operationalLog.status().directory)
      if (error) throw notAvailable(error)
      return { accepted: true }
    },
    'runtime-log:clear': async () => {
      const cleared = await operationalLog.clearHistory()
      if (!cleared) throw notAvailable('Operational log cleanup failed')
      return {
        deleted: cleared.deletedFiles,
        deletedBytes: cleared.deletedBytes,
      }
    },
  }
}
