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
  type Input,
  type OnHeadersReceivedListenerDetails,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams,
  type WebContentsWillNavigateEventParams,
} from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Disposer } from './disposer'
import { ConfigStore } from './config/store'
import { SecretStore } from './config/secret-store'
import { ElectronSafeStorageAdapter } from './config/electron-safe-storage-adapter'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../shared/notices'
import { registerIpcHandlers } from './ipc'
import { createAppIpcHandlers } from './ipc/app-handlers'
import { createHttpTransport } from './net/http-transport'
import { createElectronRuntimeEventListener } from './runtime/electron-runtime-event-sink'
import { createBackendRuntime } from './application/create-backend-runtime'
import { sendDomainStateEvent } from './ipc/event-sink'
import { BackendNotificationReporter } from './notifications/backend-notification-reporter'
import { desktopDatabasePath } from './persistence/database-service'
import {
  APP_ENTRY_URL,
  APP_HOST,
  APP_SCHEME,
  createContentSecurityPolicy,
  getDevServerUrl,
  isAllowedApplicationUrl,
  resolveAppResource,
} from './security'
import { acquireDesktopSingleInstance } from './single-instance'
import { backendStartupRecoveryPrompt } from './backend-startup-recovery'

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
  const notifications = new BackendNotificationReporter({
    getWebContents: () => mainWindow?.webContents,
  })
  let httpTransport = createHttpTransport(initialized.config.network.httpProxy)
  const refreshHttpTransport = (
    proxy: typeof initialized.config.network.httpProxy,
  ) => {
    httpTransport = createHttpTransport(proxy)
  }

  if (!initialized.secretStorage.available) {
    console.warn(
      `Secure credential storage unavailable: ${initialized.secretStorage.reason} (${initialized.secretStorage.backend})`,
    )
  }

  const backend = await openBackendWithRecovery({
    userData,
    create: () =>
      createBackendRuntime({
        configStore,
        databasePath: desktopDatabasePath(userData),
        runtimeDataDirectory: userData,
        promptDirectory: path.join(appRoot, 'resources', 'prompts'),
        appVersion: app.getVersion(),
        eventListeners: [
          createElectronRuntimeEventListener(() => mainWindow?.webContents),
        ],
        fetchImpl: (input: RequestInfo | URL, init?: RequestInit) =>
          httpTransport.fetch(input, init),
        onDiagnostic: notifications.reportDiagnostic,
      }),
  })
  appDisposer.add(() => backend.dispose())
  const unsubscribeDomainState = backend.subscribe((commit) => {
    const webContents = mainWindow?.webContents
    if (!webContents) return
    sendDomainStateEvent(webContents, {
      kind: 'commit',
      event: { version: 1, commit },
    })
  })
  appDisposer.add(unsubscribeDomainState)
  const {
    skills: skillsManager,
    traces: traceService,
    projects: projectMetadata,
    codeBackends,
    mcp: mcpManager,
  } = backend.runtime.services
  const unregister = registerIpcHandlers({
    ipcMain,
    getTrustedWebContents: () => mainWindow?.webContents,
    isAllowedUrl: (url) => isAllowedApplicationUrl(url, devServerUrl),
    handlers: createAppIpcHandlers({
      configStore,
      backend,
      skillsManager,
      traceService,
      projectMetadata,
      codeBackends,
      mcpManager,
      getHttpTransport: () => httpTransport,
      refreshHttpTransport,
      getMainWindow: () => mainWindow,
    }),
    onDiagnostic: notifications.reportInternal,
  })

  console.info(
    `P2 notices: provider=${PROVIDER_NOTICE_VERSION}, trace=${TRACE_NOTICE_VERSION}`,
  )
  appDisposer.add(unregister)
}

async function openBackendWithRecovery<T>(input: {
  userData: string
  create: () => Promise<T>
}): Promise<T> {
  for (;;) {
    try {
      return await input.create()
    } catch (error) {
      console.error('Durable backend startup failed', error)
      const prompt = backendStartupRecoveryPrompt(error)
      const buttons = prompt.retryable
        ? ['Retry', 'Open data directory', 'Exit']
        : ['Open data directory', 'Exit']
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'Durable backend unavailable',
        message: prompt.message,
        detail: prompt.detail,
        buttons,
        defaultId: prompt.retryable ? 0 : 1,
        cancelId: prompt.retryable ? 2 : 1,
        noLink: true,
      })
      if (prompt.retryable && choice === 0) continue
      const openDirectoryChoice = prompt.retryable ? 1 : 0
      if (choice === openDirectoryChoice) {
        await shell.openPath(input.userData)
      }
      throw error
    }
  }
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

function installDevToolsShortcut(
  webContents: WebContents,
  windowDisposer: Disposer,
): void {
  const toggleDevTools = (event: Event, input: Input): void => {
    if (input.type !== 'keyDown' || input.key !== 'F12') {
      return
    }

    event.preventDefault()

    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools()
    } else {
      webContents.openDevTools({ mode: 'detach' })
    }
  }

  webContents.on('before-input-event', toggleDevTools)
  windowDisposer.add(() => {
    webContents.removeListener('before-input-event', toggleDevTools)
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
  installDevToolsShortcut(window.webContents, windowDisposer)

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

const ownsDesktopInstance = acquireDesktopSingleInstance({
  requestLock: () => app.requestSingleInstanceLock(),
  onSecondInstance: (listener) => app.on('second-instance', listener),
  quit: () => app.quit(),
  getWindow: () => mainWindow,
})

if (ownsDesktopInstance) {
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
}
