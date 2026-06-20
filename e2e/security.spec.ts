import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_API_KEYS } from '../shared/agent-api'

test.describe.serial('Electron security and IPC baseline', () => {
  let electronApp: ElectronApplication
  let electronProcess: ChildProcess
  let page: Page
  let temporaryRoot: string
  let workspace: string
  let userDataPath: string

  test.beforeAll(async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    delete env.VITE_DEV_SERVER_URL
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-e2e-'))
    workspace = path.join(temporaryRoot, 'workspace')
    await mkdir(workspace)

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`],
      env,
    })
    electronProcess = electronApp.process()
    userDataPath = await electronApp.evaluate(({ app }) =>
      app.getPath('userData'),
    )
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

    await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('exposes only the frozen versioned agent API', async () => {
    const bridge = await page.evaluate(() => {
      const agentApi = Reflect.get(window, 'agentApi') as object

      return {
        agentApiKeys: Object.keys(agentApi),
        agentApiFrozen: Object.isFrozen(agentApi),
        ipcRendererType: typeof Reflect.get(window, 'ipcRenderer'),
      }
    })

    expect(bridge).toEqual({
      agentApiKeys: [...AGENT_API_KEYS],
      agentApiFrozen: true,
      ipcRendererType: 'undefined',
    })
  })

  test('serves config and the bounded skills catalog through validated IPC', async () => {
    const results = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getConfig(payload: unknown): Promise<unknown>
        listSkills(payload: unknown): Promise<unknown>
      }

      return {
        config: await api.getConfig({ version: 1, section: 'all' }),
        skills: await api.listSkills({ version: 1 }),
      }
    })

    expect(results.config).toMatchObject({
      version: 1,
      ok: true,
      value: {
        config: {
          schemaVersion: 1,
          providers: {
            deepseek: {
              credentialConfigured: expect.any(Boolean),
            },
          },
        },
      },
    })
    expect(JSON.stringify(results.config)).not.toContain('apiKeyRef')
    expect(results.skills).toMatchObject({
      version: 1,
      ok: true,
      value: { skills: [], diagnostics: [] },
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

  test('round-trips credentials through safeStorage without plaintext on disk', async () => {
    const sentinel = `provider-key-sentinel-${Date.now()}`
    const results = await page.evaluate(async (apiKey) => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<unknown>
        getConfig(payload: unknown): Promise<unknown>
      }
      const set = await api.setConfig({
        version: 1,
        kind: 'credential',
        action: 'set',
        apiKey,
      })
      const configured = await api.getConfig({ version: 1, section: 'all' })
      return { set, configured }
    }, sentinel)

    expect(results.set).toMatchObject({ version: 1, ok: true })
    expect(results.configured).toMatchObject({
      version: 1,
      ok: true,
      value: {
        config: {
          providers: { deepseek: { credentialConfigured: true } },
        },
      },
    })
    expect(
      await readFile(path.join(userDataPath, 'secrets.json'), 'utf8'),
    ).not.toContain(sentinel)

    const cleared = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<unknown>
      }
      return api.setConfig({
        version: 1,
        kind: 'credential',
        action: 'clear',
      })
    })
    expect(cleared).toMatchObject({ version: 1, ok: true })
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

  test('shows editable model discovery and budget controls', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Open settings"]',
      )
      button?.click()
    })
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Provider' })
      .click()
    const provider = page.locator('.settings-section')

    await expect(
      provider.getByText('Main model', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Context window override', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Maximum output override', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Token estimation', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByRole('button', { name: 'Refresh' }),
    ).toBeDisabled()
    await expect(provider.locator('.n-input-number')).toHaveCount(3)

    const modelSelect = provider.locator('.n-select').first()
    await modelSelect.click()
    await page.keyboard.type('custom-e2e-model')
    await page.keyboard.press('Enter')
    await expect(modelSelect).toContainText('custom-e2e-model')
    await page.keyboard.press('Escape')
  })

  test('exposes skill management and bounded trace diagnostics in settings', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open settings"]')
        ?.click()
    })
    const navigation = page.getByRole('navigation', {
      name: 'Settings sections',
    })
    await navigation.getByRole('button', { name: 'Skills' }).click()
    const skills = page.locator('.settings-section')
    await expect(skills.getByText('No valid skills found.')).toBeVisible()
    await expect(
      skills.getByPlaceholder('https://example.com/skill.md'),
    ).toBeVisible()
    await expect(
      skills.getByRole('button', { name: 'Install file' }),
    ).toBeVisible()
    await expect(skills.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await writeFile(
      path.join(userDataPath, 'skills', 'e2e-skill.md'),
      '---\nname: e2e-skill\ndescription: E2E skill without optional trigger\n---\nUse E2E instructions.\n',
    )
    await skills.getByRole('button', { name: 'Refresh' }).click()
    await expect(skills.getByText('e2e-skill', { exact: true })).toBeVisible()
    await expect(
      skills.getByText('E2E skill without optional trigger'),
    ).toBeVisible()

    await navigation.getByRole('button', { name: 'Logging' }).click()
    const logging = page.locator('.settings-section')
    await expect(
      logging.getByRole('button', { name: 'Open log directory' }),
    ).toBeVisible()
    await expect(
      logging.getByRole('button', { name: 'Clear closed traces' }),
    ).toBeVisible()
    await expect(logging.getByText('Offline replay and fork')).toBeVisible()
    await expect(logging.getByText('Requests')).toBeVisible()
  })

  test('opens, drives, restores, and closes persistent terminal tabs', async () => {
    const configured = await page.evaluate(async (workspacePath) => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{
          ok: boolean
        }>
      }
      return api.setConfig({
        version: 1,
        kind: 'workspace',
        lastOpened: workspacePath,
      })
    }, workspace)
    expect(configured.ok).toBe(true)

    await page.reload()
    const toggle = page.getByRole('button', { name: 'Toggle terminal' })
    await expect(toggle).toBeEnabled()
    await toggle.click()
    await expect(page.locator('.terminal-panel')).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(1)

    const activeInput = page.locator(
      '.terminal-surface:visible .xterm-helper-textarea',
    )
    await activeInput.click()
    await page.keyboard.type('Write-Output E2E_PTY_OK')
    await page.keyboard.press('Enter')
    await expect(
      page.locator('.terminal-surface:visible .xterm-rows'),
    ).toContainText('E2E_PTY_OK')

    await page.getByRole('button', { name: 'New terminal' }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)

    await page.keyboard.press('Control+J')
    await expect(page.locator('.terminal-panel')).toBeHidden()
    await page.keyboard.press('Control+J')
    await expect(page.locator('.terminal-panel')).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(2)

    const closeButtons = page.getByRole('button', { name: 'Close terminal' })
    await expect(closeButtons).toHaveCount(2)
    await closeButtons.nth(0).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
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
