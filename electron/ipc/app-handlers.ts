import { BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { stat } from 'node:fs/promises'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'
import { ChangeHistoryError, ChangeHistoryStore } from '../agent/change-history'
import {
  fetchOpenAICompatibleModelCatalog,
  ModelCatalogError,
  resolveModelProfiles,
} from '../agent/model-catalog'
import { PathGuard, PathGuardError } from '../agent/path-guard'
import type { SessionManager } from '../agent/session-manager'
import type { ConfigStore } from '../config/store'
import { SkillError, type SkillsManager } from '../skills/manager'
import { TraceServiceError, type TraceService } from '../logging/service'
import type { WorkbenchStore } from '../workbench/store'
import type { HttpTransport } from '../net/http-transport'
import { IpcFault, type IpcBusinessHandlers } from './index'

export interface AppIpcHandlerDependencies {
  configStore: ConfigStore
  sessionManager: SessionManager
  skillsManager: SkillsManager
  traceService: TraceService
  changeHistory: ChangeHistoryStore
  workbenchStore: WorkbenchStore
  getHttpTransport?: () => HttpTransport
  refreshHttpTransport?: (
    proxy: ReturnType<ConfigStore['getPublicConfig']>['network']['httpProxy'],
  ) => void
  getMainWindow: () => BrowserWindow | undefined
}

export function createAppIpcHandlers(
  dependencies: AppIpcHandlerDependencies,
): IpcBusinessHandlers {
  const {
    configStore,
    sessionManager,
    skillsManager,
    traceService,
    changeHistory,
    workbenchStore,
    getHttpTransport,
    refreshHttpTransport,
    getMainWindow,
  } = dependencies

  return {
    'config:get': (payload) => ({
      section: payload.section,
      config: configStore.getPublicConfig(),
    }),
    'config:set': async (payload) => {
      if (
        payload.kind === 'logging' &&
        payload.value.enabled &&
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

      if (payload.kind === 'network') {
        refreshHttpTransport?.(config.network.httpProxy)
      }

      return { config }
    },
    'provider:list-models': async (payload) => {
      const config = configStore.getPublicConfig()
      const provider = config.providers.find(
        (candidate) => candidate.id === config.activeProviderId,
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

        try {
          const models = await fetchOpenAICompatibleModelCatalog({
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
        } catch (error) {
          if (error instanceof ModelCatalogError) {
            throw new IpcFault({
              code:
                error.status === 401 || error.status === 403
                  ? 'PRECONDITION_FAILED'
                  : 'NOT_AVAILABLE',
              message:
                error.status === 401 || error.status === 403
                  ? `${provider.label} rejected the configured credential`
                  : error.message,
            })
          }

          throw error
        }
      }

      const latestConfig = configStore.getPublicConfig()
      const latestProvider =
        latestConfig.providers.find(
          (candidate) => candidate.id === latestConfig.activeProviderId,
        ) ?? latestConfig.providers[0]
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
    'workbench:get': () => workbenchStore.getSnapshot(),
    'workbench:save': (payload) =>
      workbenchStore.saveSnapshot(payload.workbench),
    'workbench:migrate-v1': (payload) =>
      workbenchStore.mergeSnapshot(payload.workbench),
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
      const workspace =
        payload.workspace ?? configStore.getPublicConfig().workspace.lastOpened

      if (!workspace) {
        throw new IpcFault({
          code: 'PRECONDITION_FAILED',
          message: 'Choose a workspace before browsing files',
        })
      }

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
      const workspace =
        payload.workspace ?? configStore.getPublicConfig().workspace.lastOpened

      if (!workspace) {
        throw new IpcFault({
          code: 'PRECONDITION_FAILED',
          message: 'Choose a workspace before opening files',
        })
      }

      try {
        const guard = await PathGuard.create(workspace)
        const maxBytes = Math.min(
          configStore.getPublicConfig().limits.readFileOutputBytes,
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
    'workspace:choose-context': async (payload) => {
      const options: OpenDialogOptions = {
        defaultPath: payload.workspace,
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
        const guard = await PathGuard.create(payload.workspace)
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
    'session:create': async (payload) => ({
      sessionId: await sessionManager.createSession({
        conversationId: payload.conversationId,
        workspace: payload.workspace,
        mode: payload.mode,
        provider: payload.provider,
      }),
    }),
    'changes:list': (payload) => ({
      changes: changeHistory.list(payload.conversationId, payload.workspace),
    }),
    'changes:revert': async (payload) => {
      try {
        return {
          change: await changeHistory.revert({
            id: payload.id,
            conversationId: payload.conversationId,
            workspace: payload.workspace,
          }),
        }
      } catch (error) {
        if (error instanceof ChangeHistoryError) {
          throw new IpcFault({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'RESOURCE_CHANGED'
                  ? 'CONFLICT'
                  : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        if (error instanceof PathGuardError) {
          throw new IpcFault({
            code: 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    },
    'session:close': async (payload) => ({
      accepted: await sessionManager.closeSession(payload.sessionId),
    }),
    'session:update-mode': async (payload) => ({
      accepted: await sessionManager.updateSessionMode(
        payload.sessionId,
        payload.mode,
      ),
    }),
    'run:start': (payload) => ({
      runId: sessionManager.startRun({
        sessionId: payload.sessionId,
        message: payload.message,
        clientRequestId: payload.clientRequestId,
        context: payload.context,
      }),
    }),
    'run:interrupt': (payload) => ({
      accepted: sessionManager.interruptRun(payload.sessionId, payload.runId),
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
    'terminal:open': async (payload) => ({
      terminal: await sessionManager.openTerminal({
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        cols: payload.cols,
        rows: payload.rows,
      }),
    }),
    'terminal:list': (payload) => ({
      terminals: sessionManager.listTerminals(payload.sessionId),
    }),
    'terminal:input': (payload) => ({
      accepted: sessionManager.sendTerminalInput(
        payload.sessionId,
        payload.terminalId,
        payload.data,
      ),
    }),
    'terminal:resize': (payload) => ({
      accepted: sessionManager.resizeTerminal(
        payload.sessionId,
        payload.terminalId,
        payload.cols,
        payload.rows,
      ),
    }),
    'terminal:close': (payload) => ({
      accepted: sessionManager.closeTerminal(
        payload.sessionId,
        payload.terminalId,
      ),
    }),
    'terminal:snapshot': (payload) =>
      sessionManager.terminalSnapshot(payload.sessionId, payload.terminalId),
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
        if (error instanceof TraceServiceError) {
          throw new IpcFault({
            code:
              error.code === 'TRACE_NOT_FOUND' ||
              error.code === 'FORK_POINT_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'trace:stats': (payload) => traceService.stats(payload.traceId),
    'trace:fork': async (payload) => {
      try {
        const point = await traceService.forkPoint(
          payload.traceId,
          payload.eventId,
        )
        return await sessionManager.createForkFromTrace(point)
      } catch (error) {
        if (error instanceof TraceServiceError) {
          throw new IpcFault({
            code:
              error.code === 'TRACE_NOT_FOUND' ||
              error.code === 'FORK_POINT_NOT_FOUND'
                ? 'NOT_FOUND'
                : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }

        throw error
      }
    },
    'trace:start-fork': (payload) => ({
      runId: sessionManager.startForkRun(payload.sessionId),
    }),
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
  }
}
