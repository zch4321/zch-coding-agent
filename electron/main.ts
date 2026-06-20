import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  type Event,
  type OnHeadersReceivedListenerDetails,
  type OpenDialogOptions,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
} from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Disposer } from './disposer'
import { ConfigStore } from './config/store'
import { ElectronSafeStorageAdapter, SecretStore } from './config/secret-store'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../shared/notices'
import { SessionManager } from './agent/session-manager'
import {
  fetchDeepSeekModelCatalog,
  ModelCatalogError,
  resolveModelProfiles,
} from './agent/model-catalog'
import { PathGuard, PathGuardError } from './agent/path-guard'
import { IpcFault, registerIpcHandlers } from './ipc'
import { PluginEventBus } from './plugins/event-bus'
import { SkillError, SkillsManager } from './skills/manager'
import { TraceService, TraceServiceError } from './logging/service'
import {
  APP_ENTRY_URL,
  APP_HOST,
  APP_SCHEME,
  createContentSecurityPolicy,
  getDevServerUrl,
  isAllowedApplicationUrl,
  resolveAppResource,
} from './security'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(currentDirectory, '..')
const rendererRoot = path.join(appRoot, 'dist')
const devServerUrl = getDevServerUrl(process.env.VITE_DEV_SERVER_URL)
const appDisposer = new Disposer({
  timeoutMs: 5_000,
  onError: (error) => console.error('Application cleanup failed', error),
})

let mainWindow: BrowserWindow | undefined
let cleanupComplete = false
let cleanupStarted = false
let configStore: ConfigStore

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
])

function installAppProtocol(): void {
  if (devServerUrl) {
    return
  }

  protocol.handle(APP_SCHEME, (request) => {
    const resourcePath = resolveAppResource(rendererRoot, request.url)

    if (!resourcePath) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    return net.fetch(pathToFileURL(resourcePath).toString())
  })

  appDisposer.add(() => protocol.unhandle(APP_SCHEME))
}

function installSessionSecurity(): void {
  const defaultSession = session.defaultSession
  const csp = createContentSecurityPolicy(devServerUrl)
  const responseFilter = {
    urls: devServerUrl
      ? [`${devServerUrl.origin}/*`]
      : [`${APP_SCHEME}://${APP_HOST}/*`],
  }

  defaultSession.webRequest.onHeadersReceived(
    responseFilter,
    (details: OnHeadersReceivedListenerDetails, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      })
    },
  )
  defaultSession.setPermissionCheckHandler(() => false)
  defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false)
    },
  )

  appDisposer.add(() => defaultSession.webRequest.onHeadersReceived(null))
  appDisposer.add(() => defaultSession.setPermissionCheckHandler(null))
  appDisposer.add(() => defaultSession.setPermissionRequestHandler(null))
}

async function installIpc(): Promise<void> {
  const userData = app.getPath('userData')
  const secretStore = new SecretStore(
    path.join(userData, 'secrets.json'),
    new ElectronSafeStorageAdapter(),
  )
  configStore = new ConfigStore(
    path.join(userData, 'config.json'),
    secretStore,
    {
      environmentApiKey: process.env.DEEPSEEK_API_KEY,
    },
  )
  const initialized = await configStore.initialize()

  if (!initialized.secretStorage.available) {
    console.warn(
      `Secure credential storage unavailable: ${initialized.secretStorage.reason} (${initialized.secretStorage.backend})`,
    )
  }

  const pluginBus = new PluginEventBus({
    onDiagnostic: (diagnostic, error) =>
      console.error(`Plugin hook ${diagnostic.hook} failed`, error),
  })
  const skillsManager = new SkillsManager(path.join(userData, 'skills'))
  await skillsManager.initialize()
  const traceService = new TraceService(path.join(userData, 'traces'))
  await traceService.initialize()
  const sessionManager = new SessionManager({
    configStore,
    traceDirectory: path.join(userData, 'traces'),
    getWebContents: () => mainWindow?.webContents,
    pluginBus,
    skillsManager,
    onDiagnostic: (message, error) => console.error(message, error),
  })
  const unregister = registerIpcHandlers({
    ipcMain,
    getTrustedWebContents: () => mainWindow?.webContents,
    isAllowedUrl: (url) => isAllowedApplicationUrl(url, devServerUrl),
    handlers: {
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

        return {
          config: await configStore.update(payload),
        }
      },
      'provider:list-models': async (payload) => {
        if (payload.refresh) {
          const apiKey = await configStore.getDeepSeekApiKey()

          if (!apiKey) {
            throw new IpcFault({
              code: 'PRECONDITION_FAILED',
              message: 'Save a DeepSeek credential before refreshing models',
            })
          }

          try {
            const config = configStore.getPublicConfig()
            const models = await fetchDeepSeekModelCatalog({
              baseURL: config.providers.deepseek.baseURL,
              apiKey,
            })
            await configStore.setDeepSeekModelCatalog(
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
                    ? 'DeepSeek rejected the configured credential'
                    : error.message,
              })
            }

            throw error
          }
        }

        const config = configStore.getPublicConfig()
        const fetchedAt = config.providers.deepseek.modelCatalogFetchedAt
        const stale =
          !fetchedAt ||
          Date.now() - new Date(fetchedAt).getTime() > 24 * 60 * 60_000

        return {
          models: resolveModelProfiles(config),
          fetchedAt,
          stale,
        }
      },
      'workspace:choose': async () => {
        const options: OpenDialogOptions = {
          properties: ['openDirectory'],
        }
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
        const workspace = configStore.getPublicConfig().workspace.lastOpened

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
        const workspace = configStore.getPublicConfig().workspace.lastOpened

        if (!workspace) {
          throw new IpcFault({
            code: 'PRECONDITION_FAILED',
            message: 'Choose a workspace before opening files',
          })
        }

        try {
          const guard = await PathGuard.create(workspace)
          return await guard.readFileBounded(payload.path, 499_999)
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
          workspace: payload.workspace,
          mode: payload.mode,
          provider: payload.provider,
        }),
      }),
      'session:close': async (payload) => ({
        accepted: await sessionManager.closeSession(payload.sessionId),
      }),
      'run:start': (payload) => ({
        runId: sessionManager.startRun({
          sessionId: payload.sessionId,
          message: payload.message,
          clientRequestId: payload.clientRequestId,
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
        deleted: await traceService.clearClosed(
          sessionManager.activeTraceIds(),
        ),
      }),
    },
    onDiagnostic: (message, error) => console.error(message, error),
  })

  console.info(
    `P2 notices: provider=${PROVIDER_NOTICE_VERSION}, trace=${TRACE_NOTICE_VERSION}`,
  )
  appDisposer.add(() => sessionManager.dispose())
  appDisposer.add(unregister)
}

function guardNavigation(
  webContents: WebContents,
  windowDisposer: Disposer,
): void {
  const preventMainFrameNavigation = (
    details: Event<WebContentsWillNavigateEventParams>,
  ): void => {
    if (!isAllowedApplicationUrl(details.url, devServerUrl)) {
      details.preventDefault()
    }
  }
  const preventFrameNavigation = (
    details: Event<WebContentsWillFrameNavigateEventParams>,
  ): void => {
    if (!isAllowedApplicationUrl(details.url, devServerUrl)) {
      details.preventDefault()
    }
  }
  const preventWebView = (event: Event): void => {
    event.preventDefault()
  }

  webContents.on('will-navigate', preventMainFrameNavigation)
  webContents.on('will-frame-navigate', preventFrameNavigation)
  webContents.on('will-attach-webview', preventWebView)
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  windowDisposer.add(() => {
    webContents.removeListener('will-navigate', preventMainFrameNavigation)
  })
  windowDisposer.add(() => {
    webContents.removeListener('will-frame-navigate', preventFrameNavigation)
  })
  windowDisposer.add(() => {
    webContents.removeListener('will-attach-webview', preventWebView)
  })
  windowDisposer.add(() => {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

async function createWindow(): Promise<void> {
  const windowDisposer = new Disposer({
    timeoutMs: 1_000,
    onError: (error) => console.error('Window cleanup failed', error),
  })
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f8fa',
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  })

  mainWindow = window
  guardNavigation(window.webContents, windowDisposer)

  const showWindow = () => window.show()
  const cleanupWindow = () => {
    if (mainWindow === window) {
      mainWindow = undefined
    }

    void windowDisposer.dispose()
  }

  window.once('ready-to-show', showWindow)
  window.once('closed', cleanupWindow)
  windowDisposer.add(() => {
    window.removeListener('ready-to-show', showWindow)
  })
  windowDisposer.add(() => {
    window.removeListener('closed', cleanupWindow)
  })

  try {
    await window.loadURL(devServerUrl?.href ?? APP_ENTRY_URL)
  } catch (error) {
    await windowDisposer.dispose()

    if (!window.isDestroyed()) {
      window.destroy()
    }

    throw error
  }
}

app.on('before-quit', (event) => {
  if (cleanupComplete) {
    return
  }

  event.preventDefault()

  if (cleanupStarted) {
    return
  }

  cleanupStarted = true
  void appDisposer.dispose().finally(() => {
    cleanupComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().catch((error) => {
      console.error('Failed to recreate the main window', error)
    })
  }
})

void app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(null)
    installAppProtocol()
    installSessionSecurity()
    await installIpc()
    await createWindow()
  })
  .catch((error) => {
    console.error('Application startup failed', error)
    app.exit(1)
  })
