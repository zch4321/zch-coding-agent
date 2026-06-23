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
          schemaVersion: 4,
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

  test('shows configurable prompts, model discovery, and budget controls', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="打开设置"]',
      )
      button?.click()
    })
    const settingsNavigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await settingsNavigation.getByRole('button', { name: '通用' }).click()
    const general = page.locator('.settings-section')
    await expect(general.getByText('中文系统提示词')).toBeVisible()
    await expect(general.getByText('英文系统提示词')).toBeVisible()
    const zhPrompt = general
      .locator('.settings-field', { hasText: '中文系统提示词' })
      .locator('textarea')
    const saveStatus = general.locator('.settings-save-status')
    await zhPrompt.fill('E2E 中文系统提示词')
    await expect(zhPrompt).toHaveValue('E2E 中文系统提示词')
    await general.getByRole('button', { name: '保存系统提示词' }).click()
    await expect(saveStatus).toHaveText('已保存')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              ok: boolean
              value?: {
                config: {
                  assistant: { systemPrompts: Record<string, string> }
                }
              }
            }>
          }
          const savedPrompt = await api.getConfig({
            version: 1,
            section: 'assistant',
          })
          return savedPrompt.value?.config.assistant.systemPrompts['zh-CN']
        }),
      )
      .toBe('E2E 中文系统提示词')
    await general.getByRole('button', { name: '恢复默认提示词' }).click()
    await general.getByRole('button', { name: '保存系统提示词' }).click()
    await expect(saveStatus).toHaveText('已保存')

    await settingsNavigation.getByRole('button', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')

    await expect(provider.getByText('主模型', { exact: true })).toBeVisible()
    await expect(
      provider.getByText('上下文窗口覆盖值', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('最大输出覆盖值', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Token 估算方式', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Provider Profile', { exact: true }),
    ).toBeVisible()
    await expect(provider.getByRole('button', { name: '刷新' })).toBeDisabled()
    await expect(provider.getByText('思考深度', { exact: true })).toBeVisible()
    await expect(provider.locator('.n-input-number')).toHaveCount(3)

    const modelSelect = provider
      .locator('.settings-field', { hasText: '主模型' })
      .locator('.n-select')
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
        .querySelector<HTMLButtonElement>('[aria-label="打开设置"]')
        ?.click()
    })
    const navigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await navigation.getByRole('button', { name: '技能' }).click()
    const skills = page.locator('.settings-section')
    await expect(skills.getByText('未找到有效技能。')).toBeVisible()
    await expect(
      skills.getByPlaceholder('https://example.com/skill.md'),
    ).toBeVisible()
    await expect(skills.getByRole('button', { name: '安装文件' })).toBeVisible()
    await expect(skills.getByRole('button', { name: '刷新' })).toBeVisible()
    await writeFile(
      path.join(userDataPath, 'skills', 'e2e-skill.md'),
      '---\nname: e2e-skill\ndescription: E2E skill without optional trigger\n---\nUse E2E instructions.\n',
    )
    await skills.getByRole('button', { name: '刷新' }).click()
    await expect(skills.getByText('e2e-skill', { exact: true })).toBeVisible()
    await expect(
      skills.getByText('E2E skill without optional trigger'),
    ).toBeVisible()

    await navigation.getByRole('button', { name: '日志' }).click()
    const logging = page.locator('.settings-section')
    await expect(
      logging.getByRole('button', { name: '打开日志目录' }),
    ).toBeVisible()
    await expect(
      logging.getByRole('button', { name: '清理已关闭 Trace' }),
    ).toBeVisible()
    await expect(logging.getByText('离线回放与分叉')).toBeVisible()
    await expect(logging.getByText('请求数', { exact: true })).toBeVisible()
  })

  test('collapses projects and renders file tabs as one active tab unit', async () => {
    await writeFile(path.join(workspace, 'blog.pen'), 'sample design\n')
    const cachedDirectory = path.join(workspace, 'cached-folder')
    await mkdir(cachedDirectory)
    await writeFile(path.join(cachedDirectory, 'cached.txt'), 'cached child\n')
    const configured = await page.evaluate(async (workspacePath) => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      return api.setConfig({
        version: 1,
        kind: 'workspace',
        lastOpened: workspacePath,
      })
    }, workspace)
    expect(configured.ok).toBe(true)

    await page.reload()
    const artifactToggle = page.getByRole('button', {
      name: '切换文件侧栏（Ctrl+Shift+B）',
    })
    if ((await artifactToggle.getAttribute('aria-pressed')) !== 'true') {
      await artifactToggle.click()
    }
    await expect(page.locator('.artifact-sidebar')).toBeVisible()
    const projectToggle = page.getByRole('button', {
      name: '切换项目侧栏（Ctrl+B）',
    })
    if ((await projectToggle.getAttribute('aria-pressed')) !== 'true') {
      await projectToggle.click()
    }
    await expect(page.locator('.project-sidebar')).toBeVisible()
    const projectHeading = page.locator('.project-heading')
    const conversationList = page.locator('.conversation-list')
    await expect(projectHeading).toHaveAttribute('aria-expanded', 'true')
    await projectHeading.click()
    await expect(projectHeading).toHaveAttribute('aria-expanded', 'false')
    await expect(conversationList).toBeHidden()
    await projectHeading.click()
    await expect(conversationList).toBeVisible()

    if ((await artifactToggle.getAttribute('aria-pressed')) !== 'true') {
      await artifactToggle.click()
    }
    await expect(page.locator('.artifact-sidebar')).toBeVisible()

    const folderNode = page.getByText('cached-folder', { exact: true })
    await folderNode.click()
    await expect(page.locator('.explorer-tree')).toContainText('cached.txt')
    await rm(path.join(cachedDirectory, 'cached.txt'))
    await folderNode.click()
    await folderNode.click()
    await expect(page.locator('.explorer-tree')).toContainText('cached.txt')

    await page.getByText('blog.pen', { exact: true }).click()
    const activeFileTab = page.locator('.file-tab.active')
    await expect(activeFileTab).toContainText('blog.pen')
    await expect(page.locator('.file-viewer-header')).toContainText('blog.pen')
    const tabLayout = await activeFileTab.evaluate((tab) => {
      const label = tab.querySelector('.file-tab-label')
      const close = tab.querySelector('.tab-close')
      return {
        childCount: tab.children.length,
        display: getComputedStyle(tab).display,
        activeUnderline: getComputedStyle(tab).boxShadow,
        labelHeight: label?.getBoundingClientRect().height,
        closeHeight: close?.getBoundingClientRect().height,
      }
    })
    expect(tabLayout).toMatchObject({
      childCount: 2,
      display: 'flex',
      labelHeight: tabLayout.closeHeight,
    })
    expect(tabLayout.activeUnderline).not.toBe('none')
  })

  test('keeps the file tree bound to the selected project conversation', async () => {
    const firstWorkspace = path.join(temporaryRoot, 'project-a')
    const secondWorkspace = path.join(temporaryRoot, 'project-b')
    await mkdir(firstWorkspace)
    await mkdir(secondWorkspace)
    await writeFile(path.join(firstWorkspace, 'only-a.txt'), 'project a\n')
    await writeFile(path.join(secondWorkspace, 'only-b.txt'), 'project b\n')
    const configured = await page.evaluate(async (workspacePath) => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      return api.setConfig({
        version: 1,
        kind: 'workspace',
        lastOpened: workspacePath,
      })
    }, firstWorkspace)
    expect(configured.ok).toBe(true)
    const savedWorkbench = await page.evaluate(
      ({ first, second }) => {
        const api = Reflect.get(window, 'agentApi') as {
          saveWorkbench(payload: unknown): Promise<{ ok: boolean }>
        }
        const timestamp = '2026-06-21T00:00:00.000Z'
        return api.saveWorkbench({
          version: 1,
          workbench: {
            projects: [
              { path: first, name: 'project-a', addedAt: timestamp },
              { path: second, name: 'project-b', addedAt: timestamp },
            ],
            conversations: [
              {
                id: 'conversation:a',
                projectPath: first,
                title: 'Project A conversation',
                model: 'deepseek-v4-pro',
                mode: 'auto',
                messages: [
                  {
                    id: 'message:a',
                    role: 'user',
                    text: 'seed project a',
                    reasoning: '',
                    order: 1,
                  },
                ],
                tools: [],
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              {
                id: 'conversation:b',
                projectPath: second,
                title: 'Project B conversation',
                model: 'deepseek-v4-pro',
                mode: 'auto',
                messages: [
                  {
                    id: 'message:b',
                    role: 'user',
                    text: 'seed project b',
                    reasoning: '',
                    order: 1,
                  },
                ],
                tools: [],
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            activeConversationId: 'conversation:a',
          },
        })
      },
      { first: firstWorkspace, second: secondWorkspace },
    )
    expect(savedWorkbench.ok).toBe(true)

    await page.reload()
    await page
      .getByRole('button', { name: 'Project B conversation', exact: true })
      .click()
    await expect(page.locator('.artifact-project')).toContainText(
      secondWorkspace,
    )
    await expect(page.locator('.explorer-tree')).toContainText('only-b.txt')
    await expect(page.locator('.explorer-tree')).not.toContainText('only-a.txt')

    await page
      .getByRole('button', { name: 'Project A conversation', exact: true })
      .click()
    await expect(page.locator('.artifact-project')).toContainText(
      firstWorkspace,
    )
    await expect(page.locator('.explorer-tree')).toContainText('only-a.txt')
    await expect(page.locator('.explorer-tree')).not.toContainText('only-b.txt')
  })

  test('docks the artifact sidebar without covering the conversation scrollbar on narrow desktop widths', async () => {
    await page.setViewportSize({ width: 1000, height: 720 })
    const updatedWorkbench = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getWorkbench(payload: unknown): Promise<{
          ok: boolean
          value?: {
            conversations: Array<Record<string, unknown>>
            activeConversationId?: string
          }
        }>
        saveWorkbench(payload: unknown): Promise<{ ok: boolean }>
      }
      const loaded = await api.getWorkbench({ version: 1 })
      if (!loaded.ok || !loaded.value) {
        throw new Error('Expected workbench load to succeed')
      }
      const workbench = loaded.value
      const active = workbench.conversations?.find(
        (conversation) => conversation.id === workbench.activeConversationId,
      )
      if (!active) throw new Error('Expected an active conversation')
      active.title =
        '详细分析项目，添加一个 code-review 报告，但是不要修改任何文件或覆盖现有内容'
      return api.saveWorkbench({ version: 1, workbench })
    })
    expect(updatedWorkbench.ok).toBe(true)
    await page.reload()
    const artifactToggle = page.getByRole('button', {
      name: '切换文件侧栏（Ctrl+Shift+B）',
    })
    if ((await artifactToggle.getAttribute('aria-pressed')) !== 'true') {
      await artifactToggle.click()
    }
    await expect(page.locator('.artifact-sidebar')).toBeVisible()

    const metrics = await page.evaluate(() => {
      const pane = document.querySelector('.conversation-pane')
      const scroll = document.querySelector('.conversation-scroll')
      const artifact = document.querySelector('.artifact-sidebar')
      const title = document.querySelector('.conversation-header h1')
      const composer = document.querySelector('.message-input-area')
      const composerToolbar = document.querySelector('.message-input-toolbar')
      if (
        !pane ||
        !scroll ||
        !artifact ||
        !title ||
        !composer ||
        !composerToolbar
      ) {
        throw new Error('Expected workbench layout elements')
      }
      const paneRect = pane.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      const artifactRect = artifact.getBoundingClientRect()
      const titleRect = title.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      const toolbarRect = composerToolbar.getBoundingClientRect()
      return {
        paneRight: paneRect.right,
        scrollRight: scrollRect.right,
        titleRight: titleRect.right,
        composerRight: composerRect.right,
        toolbarRight: toolbarRect.right,
        artifactLeft: artifactRect.left,
        artifactPosition: getComputedStyle(artifact).position,
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
      }
    })

    expect(metrics.artifactPosition).not.toBe('absolute')
    expect(metrics.paneRight).toBeLessThanOrEqual(metrics.artifactLeft)
    expect(metrics.scrollRight).toBeLessThanOrEqual(metrics.artifactLeft)
    expect(metrics.titleRight).toBeLessThanOrEqual(metrics.artifactLeft)
    expect(metrics.composerRight).toBeLessThanOrEqual(metrics.artifactLeft)
    expect(metrics.toolbarRight).toBeLessThanOrEqual(metrics.artifactLeft)
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth)
  })

  test('contains very long tool result lines inside the tool card', async () => {
    const savedWorkbench = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getWorkbench(payload: unknown): Promise<{
          ok: boolean
          value?: {
            conversations: Array<Record<string, unknown>>
            activeConversationId?: string
          }
        }>
        saveWorkbench(payload: unknown): Promise<{ ok: boolean }>
      }
      const loaded = await api.getWorkbench({ version: 1 })
      const workbench = loaded.value
      if (!workbench) throw new Error('Expected workbench')
      const active = workbench.conversations?.find(
        (conversation) => conversation.id === workbench.activeConversationId,
      )
      if (!active) throw new Error('Expected an active conversation')
      active.tools = [
        {
          callId: 'call:long-result',
          runId: 'run:long-result',
          tool: 'run_command',
          args: { command: 'print-long-line' },
          reason: 'Test long output containment',
          status: 'completed',
          result: { status: 'ok', content: 'x'.repeat(20_000) },
          order: 1,
        },
      ]
      return api.saveWorkbench({ version: 1, workbench })
    })
    expect(savedWorkbench.ok).toBe(true)

    await page.reload()
    const card = page.locator('.tool-call-card')
    await expect(card).toBeVisible()
    await card
      .locator('.n-collapse-item__header-main')
      .evaluate((element: HTMLElement) => element.click())
    await expect(card.locator('.tool-result-json')).toBeVisible()
    const metrics = await card.evaluate((element) => {
      const pane = document.querySelector('.conversation-pane')
      const scroll = document.querySelector('.conversation-scroll')
      const pre = element.querySelector('.tool-result-json')
      if (!pane || !scroll || !pre) throw new Error('Expected tool layout')
      const paneRect = pane.getBoundingClientRect()
      const cardRect = element.getBoundingClientRect()
      return {
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        paneLeft: paneRect.left,
        paneRight: paneRect.right,
        outerClientWidth: scroll.clientWidth,
        outerScrollWidth: scroll.scrollWidth,
        resultClientWidth: pre.clientWidth,
        resultScrollWidth: pre.scrollWidth,
      }
    })

    expect(metrics.cardLeft).toBeGreaterThanOrEqual(metrics.paneLeft)
    expect(metrics.cardRight).toBeLessThanOrEqual(metrics.paneRight)
    expect(metrics.outerScrollWidth).toBe(metrics.outerClientWidth)
    expect(metrics.resultScrollWidth).toBeLessThanOrEqual(
      metrics.resultClientWidth,
    )
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
    const toggle = page.getByRole('button', { name: /切换终端/ })
    await expect(toggle).toBeEnabled()
    await toggle.click()
    const terminalPanel = page.locator('.terminal-panel')
    const terminalTabs = terminalPanel.getByRole('tab')
    await expect(terminalPanel).toBeVisible()
    await expect(terminalTabs).toHaveCount(1)

    const activeInput = page.locator(
      '.terminal-surface:visible .xterm-helper-textarea',
    )
    await activeInput.click()
    await page.keyboard.type('Write-Output E2E_PTY_OK')
    await page.keyboard.press('Enter')
    await expect(
      page.locator('.terminal-surface:visible .xterm-rows'),
    ).toContainText('E2E_PTY_OK')

    await terminalPanel.getByRole('button', { name: '新建终端' }).click()
    await expect(terminalTabs).toHaveCount(2)

    await page.keyboard.press('Control+J')
    await expect(terminalPanel).toBeHidden()
    await page.keyboard.press('Control+J')
    await expect(terminalPanel).toBeVisible()
    await expect(terminalTabs).toHaveCount(2)

    const closeButtons = terminalPanel.getByRole('button', {
      name: '关闭终端',
    })
    await expect(closeButtons).toHaveCount(2)
    await closeButtons.nth(0).click()
    await expect(terminalTabs).toHaveCount(1)
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
