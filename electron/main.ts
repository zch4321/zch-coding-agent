import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  type Event,
  type OnHeadersReceivedListenerDetails,
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
import { ChangeHistoryStore } from './agent/change-history'
import { registerIpcHandlers } from './ipc'
import { createAppIpcHandlers } from './ipc/app-handlers'
import { PluginEventBus } from './plugins/event-bus'
import { SkillsManager } from './skills/manager'
import { TraceService } from './logging/service'
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
  const configStore = new ConfigStore(
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
  const changeHistory = new ChangeHistoryStore(
    path.join(userData, 'change-history.json'),
  )
  await changeHistory.initialize()
  const sessionManager = new SessionManager({
    configStore,
    traceDirectory: path.join(userData, 'traces'),
    getWebContents: () => mainWindow?.webContents,
    pluginBus,
    skillsManager,
    changeHistory,
    onDiagnostic: (message, error) => console.error(message, error),
  })
  const unregister = registerIpcHandlers({
    ipcMain,
    getTrustedWebContents: () => mainWindow?.webContents,
    isAllowedUrl: (url) => isAllowedApplicationUrl(url, devServerUrl),
    handlers: createAppIpcHandlers({
      configStore,
      sessionManager,
      skillsManager,
      traceService,
      changeHistory,
      getMainWindow: () => mainWindow,
    }),
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
