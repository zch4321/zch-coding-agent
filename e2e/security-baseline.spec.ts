import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_API_KEYS } from '../shared/agent-api'
import {
  disposeElectronHarness,
  launchElectronHarness,
  type ElectronHarness,
} from './support/electron-harness'

test.describe.serial('Electron security and IPC baseline', () => {
  let harness: ElectronHarness
  let page: Page
  let userDataPath: string

  test.beforeAll(async () => {
    harness = await launchElectronHarness('agent-e2e-')
    ;({ page, userDataPath } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => disposeElectronHarness(harness))

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
          schemaVersion: 13,
          subagents: {
            enabled: false,
            workerTimeoutMs: 1_800_000,
          },
          mcpServers: [],
          activeProviderId: 'deepseek',
          providers: [
            {
              id: 'deepseek',
              credentialConfigured: expect.any(Boolean),
            },
          ],
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
          providers: [
            {
              id: 'deepseek',
              credentialConfigured: true,
            },
          ],
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
    const inlineStyleCspErrors: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      if (
        message.type() === 'error' &&
        text.includes('Content Security Policy') &&
        text.includes('inline style')
      ) {
        inlineStyleCspErrors.push(text)
      }
    })

    const response = await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const policy = (await response?.allHeaders())?.['content-security-policy']

    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain("object-src 'none'")
    await page.waitForTimeout(50)
    expect(inlineStyleCspErrors).toEqual([])

    const inlineStyleWidth = await page.evaluate(() => {
      const element = document.createElement('div')
      element.setAttribute('style', 'position: absolute; width: 17px;')
      document.body.append(element)
      const width = getComputedStyle(element).width
      element.remove()
      return width
    })

    expect(inlineStyleWidth).toBe('17px')

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
})
