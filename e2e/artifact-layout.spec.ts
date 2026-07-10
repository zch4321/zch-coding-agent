import { expect, test, type Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  disposeElectronHarness,
  launchElectronHarness,
  type ElectronHarness,
} from './support/electron-harness'

test.describe.serial('Electron artifact and layout workflows', () => {
  let harness: ElectronHarness
  let page: Page
  let temporaryRoot: string
  let workspace: string

  test.beforeAll(async () => {
    harness = await launchElectronHarness('agent-e2e-')
    ;({ page, temporaryRoot, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => disposeElectronHarness(harness))

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
      name: '切换右侧栏（Ctrl+Shift+B）',
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
    const updatedWorkbench = await page.evaluate(async (workspacePath) => {
      const api = Reflect.get(window, 'agentApi') as {
        getWorkbench(payload: unknown): Promise<{
          ok: boolean
          value?: {
            projects?: Array<Record<string, unknown>>
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
      const title =
        '详细分析项目，添加一个 code-review 报告，但是不要修改任何文件或覆盖现有内容'

      if (active) {
        active.title = title
      } else {
        const timestamp = '2026-06-22T00:00:00.000Z'
        workbench.projects = [
          ...(workbench.projects ?? []),
          { path: workspacePath, name: 'workspace', addedAt: timestamp },
        ]
        workbench.conversations = [
          ...(workbench.conversations ?? []),
          {
            id: 'conversation:layout',
            projectPath: workspacePath,
            title,
            model: 'deepseek-chat',
            mode: 'auto',
            messages: [],
            tools: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]
        workbench.activeConversationId = 'conversation:layout'
      }

      return api.saveWorkbench({ version: 1, workbench })
    }, workspace)
    expect(updatedWorkbench.ok).toBe(true)
    await page.reload()
    const artifactToggle = page.getByRole('button', {
      name: '切换右侧栏（Ctrl+Shift+B）',
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
    const layoutTolerancePx = 0.5
    const artifactLeftBoundary = metrics.artifactLeft + layoutTolerancePx
    expect(metrics.paneRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.scrollRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.titleRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.composerRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.toolbarRight).toBeLessThanOrEqual(artifactLeftBoundary)
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
    await card.locator('.tool-call-row').click()
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
})
