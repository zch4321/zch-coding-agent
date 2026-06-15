import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'

test.describe.serial('P0 Electron security baseline', () => {
  let electronApp: ElectronApplication
  let electronProcess: ChildProcess
  let page: Page

  test.beforeAll(async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    delete env.VITE_DEV_SERVER_URL

    electronApp = await electron.launch({
      args: ['.'],
      env,
    })
    electronProcess = electronApp.process()
    page = await electronApp.firstWindow()
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => {
    if (
      electronProcess.exitCode === null &&
      electronProcess.signalCode === null
    ) {
      await electronApp.close()
    }
  })

  test('exposes only the frozen P0 agent API skeleton', async () => {
    const bridge = await page.evaluate(() => {
      const agentApi = Reflect.get(window, 'agentApi') as object

      return {
        agentApiKeys: Object.keys(agentApi),
        agentApiFrozen: Object.isFrozen(agentApi),
        ipcRendererType: typeof Reflect.get(window, 'ipcRenderer'),
      }
    })

    expect(bridge).toEqual({
      agentApiKeys: [],
      agentApiFrozen: true,
      ipcRendererType: 'undefined',
    })
  })

  test('keeps Node.js and child_process unavailable to renderer code', async () => {
    const isolation = await page.evaluate(async () => {
      let childProcessImport = 'unexpected-success'

      try {
        await import('node:child_process')
      } catch {
        childProcessImport = 'blocked'
      }

      return {
        requireType: typeof Reflect.get(window, 'require'),
        processType: typeof Reflect.get(window, 'process'),
        childProcessImport,
      }
    })

    expect(isolation).toEqual({
      requireType: 'undefined',
      processType: 'undefined',
      childProcessImport: 'blocked',
    })
  })

  test('injects CSP and blocks inline script execution paths', async () => {
    const response = await page.reload()
    const policy = (await response?.allHeaders())?.['content-security-policy']

    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("object-src 'none'")

    const executionCount = await page.evaluate(async () => {
      const testWindow = window as Window & { __p0ExecutionCount?: number }
      testWindow.__p0ExecutionCount = 0

      const script = document.createElement('script')
      script.textContent = 'window.__p0ExecutionCount += 1'
      document.body.append(script)

      const button = document.createElement('button')
      button.setAttribute('onclick', 'window.__p0ExecutionCount += 1')
      document.body.append(button)
      button.click()

      const link = document.createElement('a')
      link.href = 'javascript:window.__p0ExecutionCount += 1'
      document.body.append(link)
      link.click()

      await new Promise((resolve) => setTimeout(resolve, 50))
      return testWindow.__p0ExecutionCount
    })

    expect(executionCount).toBe(0)
  })

  test('denies external navigation, frames, windows, and permissions', async () => {
    const applicationUrl = page.url()
    const windowWasCreated = await page.evaluate(
      () => window.open('https://example.com') !== null,
    )

    expect(windowWasCreated).toBe(false)

    await page.evaluate(() => {
      window.location.href = 'https://example.com'
    })
    await page.waitForTimeout(150)
    expect(page.url()).toBe(applicationUrl)

    await page.evaluate(() => {
      const frame = document.createElement('iframe')
      frame.src = 'https://example.com'
      document.body.append(frame)
    })
    await page.waitForTimeout(150)
    expect(
      page
        .frames()
        .some((frame) => frame.url().startsWith('https://example.com')),
    ).toBe(false)

    const permission = await page.evaluate(async () =>
      Notification.requestPermission(),
    )
    expect(permission).toBe('denied')
  })

  test('closes cleanly with exit code zero', async () => {
    const exit = new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      electronProcess.once('exit', (code, signal) => resolve({ code, signal }))
    })

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })

    await expect(exit).resolves.toEqual({ code: 0, signal: null })
  })
})
