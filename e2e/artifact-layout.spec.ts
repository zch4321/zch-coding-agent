import { expect, test, type Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  configureApp,
  findDurableMessageText,
  startDurableSession,
} from './support/app-helpers'
import { textDelta, type FakeProvider } from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

test.describe.serial('Electron artifact and layout workflows', () => {
  let harness: FeatureHarness
  let fakeProvider: FakeProvider
  let page: Page
  let temporaryRoot: string
  let workspace: string

  test.beforeAll(async () => {
    harness = await launchFeatureHarness()
    ;({ fakeProvider, page, temporaryRoot, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => disposeFeatureHarness(harness))

  test('collapses projects and drills from the explorer into one file preview', async () => {
    await writeFile(
      path.join(workspace, 'blog.pen'),
      Array.from(
        { length: 200 },
        (_, index) => `sample design ${index}\n`,
      ).join(''),
    )
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        writeFile(
          path.join(
            workspace,
            `scroll-fixture-${String(index).padStart(2, '0')}.txt`,
          ),
          `fixture ${index}\n`,
        ),
      ),
    )
    const cachedDirectory = path.join(workspace, 'cached-folder')
    await mkdir(cachedDirectory)
    await writeFile(path.join(cachedDirectory, 'cached.txt'), 'cached child\n')
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const artifactToggle = page.getByRole('button', {
      name: '切换右侧栏（Ctrl+Shift+B）',
    })
    if ((await artifactToggle.getAttribute('aria-pressed')) !== 'true') {
      await artifactToggle.click()
    }
    await expect(page.locator('.artifact-sidebar')).toBeVisible()
    await expect(page.locator('.artifact-tabs')).toHaveClass(
      /n-tabs--line-type/,
    )
    await expect(page.locator('.artifact-sidebar .n-tabs')).toHaveCount(1)

    const artifactSpacing = await page.evaluate(() => {
      const sidebar = document.querySelector('.artifact-sidebar')
      const outerTab = document.querySelector('.artifact-tabs .n-tabs-tab')
      const content = document.querySelector('.explorer-view')
      if (!sidebar || !outerTab || !content) {
        throw new Error('Expected the artifact tabs and explorer content')
      }
      const sidebarRect = sidebar.getBoundingClientRect()
      return {
        sidebarLeft: sidebarRect.left,
        outerTabLeft: outerTab.getBoundingClientRect().left,
        contentLeft: content.getBoundingClientRect().left,
      }
    })
    expect(artifactSpacing.outerTabLeft - artifactSpacing.sidebarLeft).toBe(12)
    expect(artifactSpacing.contentLeft - artifactSpacing.sidebarLeft).toBe(0)

    const projectToggle = page.getByRole('button', {
      name: '切换项目侧栏（Ctrl+B）',
    })
    if ((await artifactToggle.getAttribute('aria-pressed')) === 'true') {
      await artifactToggle.click()
    }
    if ((await projectToggle.getAttribute('aria-pressed')) !== 'true') {
      await projectToggle.click()
    }
    const projectSidebar = page.locator('.project-sidebar')
    await expect(projectSidebar).toBeVisible()
    await expect
      .poll(() => projectSidebar.evaluate((sidebar) => sidebar.clientWidth))
      .toBe(320)
    const sidebarLayout = await projectSidebar.evaluate((sidebar) => {
      const sidebarBounds = sidebar.getBoundingClientRect()
      const selectors = [
        '.new-conversation-button',
        '.import-conversation-button',
        '.conversation-list',
      ]
      return {
        clientWidth: sidebar.clientWidth,
        scrollWidth: sidebar.scrollWidth,
        background: getComputedStyle(sidebar).backgroundColor,
        listBackground: getComputedStyle(
          sidebar.querySelector('.conversation-list') as HTMLElement,
        ).backgroundColor,
        children: selectors.map((selector) => {
          const bounds = (
            sidebar.querySelector(selector) as HTMLElement
          ).getBoundingClientRect()
          return {
            selector,
            left: bounds.left,
            right: bounds.right,
            sidebarLeft: sidebarBounds.left,
            sidebarRight: sidebarBounds.right,
          }
        }),
      }
    })
    expect(sidebarLayout.scrollWidth).toBeLessThanOrEqual(
      sidebarLayout.clientWidth,
    )
    expect(sidebarLayout.listBackground).toBe(sidebarLayout.background)
    for (const child of sidebarLayout.children) {
      expect(child.left, child.selector).toBeGreaterThanOrEqual(
        child.sidebarLeft,
      )
      expect(child.right, child.selector).toBeLessThanOrEqual(
        child.sidebarRight,
      )
    }
    const projectHeading = page.locator('.project-heading').first()
    const conversationList = page.locator('.conversation-list').first()
    await expect(projectHeading).toHaveAttribute('aria-expanded', 'true')
    await projectHeading.click()
    await expect(projectHeading).toHaveAttribute('aria-expanded', 'false')
    await expect(conversationList).toBeHidden()
    await projectHeading.click()
    await expect(conversationList).toBeVisible()

    if ((await projectToggle.getAttribute('aria-pressed')) === 'true') {
      await projectToggle.click()
    }
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
    await expect(page.locator('.file-viewer-header')).toContainText('blog.pen')
    await expect(page.locator('.explorer-view')).toBeHidden()
    await expect(
      page.getByRole('button', {
        name: '使用系统默认应用打开',
      }),
    ).toBeVisible()
    const fileScroll = await page.locator('.file-viewer').evaluate((viewer) => {
      viewer.scrollTop = viewer.scrollHeight
      return {
        clientHeight: viewer.clientHeight,
        scrollHeight: viewer.scrollHeight,
        scrollTop: viewer.scrollTop,
      }
    })
    expect(fileScroll.scrollHeight).toBeGreaterThan(fileScroll.clientHeight)
    expect(fileScroll.scrollTop).toBeGreaterThan(0)

    await page
      .getByRole('button', { name: '返回资源管理器', exact: true })
      .click()
    await expect(page.locator('.file-viewer')).toBeHidden()
    await expect(page.locator('.explorer-view')).toBeVisible()
    const explorerTree = page.locator('.explorer-tree')
    await expect
      .poll(
        () =>
          explorerTree.evaluate((tree) => {
            const container = tree.querySelector('.v-vl')
            const rail = tree.querySelector('.n-scrollbar-rail--vertical')
            const thumb = rail?.querySelector('.n-scrollbar-rail__scrollbar')
            return (
              container instanceof HTMLElement &&
              rail instanceof HTMLElement &&
              thumb instanceof HTMLElement &&
              container.scrollHeight > container.clientHeight &&
              rail.getBoundingClientRect().height > 0 &&
              thumb.getBoundingClientRect().height > 0
            )
          }),
        { timeout: 10_000 },
      )
      .toBe(true)
    const treeScroll = await explorerTree.evaluate((tree) => {
      const container = tree.querySelector('.v-vl')
      const rail = tree.querySelector('.n-scrollbar-rail--vertical')
      if (
        !(container instanceof HTMLElement) ||
        !(rail instanceof HTMLElement)
      ) {
        throw new Error('Expected the resource tree scrollbar')
      }
      container.scrollTop = container.scrollHeight
      return {
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        railHeight: rail.getBoundingClientRect().height,
      }
    })
    expect(treeScroll.scrollHeight).toBeGreaterThan(treeScroll.clientHeight)
    expect(treeScroll.scrollTop).toBeGreaterThan(0)
    expect(treeScroll.railHeight).toBeGreaterThan(0)
  })

  test('keeps the file tree bound to the selected Durable Session project', async () => {
    const firstWorkspace = path.join(temporaryRoot, 'project-a')
    const secondWorkspace = path.join(temporaryRoot, 'project-b')
    await mkdir(firstWorkspace)
    await mkdir(secondWorkspace)
    await writeFile(path.join(firstWorkspace, 'only-a.txt'), 'project a\n')
    await writeFile(path.join(secondWorkspace, 'only-b.txt'), 'project b\n')

    fakeProvider.queue([textDelta('Project A ready')])
    await startDurableSession({
      page,
      workspace: firstWorkspace,
      title: 'Project A session',
      message: 'seed project a',
    })
    await expect
      .poll(() =>
        findDurableMessageText(page, 'seed project a', 'assistant_turn'),
      )
      .toBe('Project A ready')
    await expect(page.locator('.n-message')).toHaveCount(0)

    fakeProvider.queue([textDelta('Project B ready')])
    await startDurableSession({
      page,
      workspace: secondWorkspace,
      title: 'Project B session',
      message: 'seed project b',
    })
    await expect
      .poll(() =>
        findDurableMessageText(page, 'seed project b', 'assistant_turn'),
      )
      .toBe('Project B ready')
    await expect(page.locator('.n-message')).toHaveCount(0)

    await page.reload()
    await page
      .getByRole('button', { name: 'Project B session', exact: true })
      .click()
    await expect(page.locator('.artifact-project')).toContainText(
      secondWorkspace,
    )
    await expect(page.locator('.explorer-tree')).toContainText('only-b.txt')
    await expect(page.locator('.explorer-tree')).not.toContainText('only-a.txt')

    await page
      .getByRole('button', { name: 'Project A session', exact: true })
      .click()
    await expect(page.locator('.artifact-project')).toContainText(
      firstWorkspace,
    )
    await expect(page.locator('.explorer-tree')).toContainText('only-a.txt')
    await expect(page.locator('.explorer-tree')).not.toContainText('only-b.txt')
  })

  test('docks the artifact sidebar without covering the conversation scrollbar', async () => {
    const title =
      '详细分析项目，添加一个 code-review 报告，但是不要修改任何文件或覆盖现有内容'
    fakeProvider.queue([textDelta('Layout session ready')])
    await startDurableSession({
      page,
      workspace,
      title,
      message: 'create the narrow layout fixture',
    })
    await expect
      .poll(() =>
        findDurableMessageText(
          page,
          'create the narrow layout fixture',
          'assistant_turn',
        ),
      )
      .toBe('Layout session ready')
    await page.reload()
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(
      page.locator('.chat-message.user > .message-meta'),
    ).toHaveCount(0)
    await expect(
      page.locator('.chat-message.assistant > .message-meta > strong'),
    ).toHaveCount(0)
    const messageCenters = await page.evaluate(() => {
      const user = document.querySelector('.chat-message.user')
      const assistant = document.querySelector('.chat-message.assistant')
      if (!user || !assistant) throw new Error('Expected chat messages')
      const userBounds = user.getBoundingClientRect()
      const assistantBounds = assistant.getBoundingClientRect()
      return {
        user: userBounds.left + userBounds.width / 2,
        assistant: assistantBounds.left + assistantBounds.width / 2,
      }
    })
    expect(
      Math.abs(messageCenters.user - messageCenters.assistant),
    ).toBeLessThan(1)
    await page.setViewportSize({ width: 1000, height: 720 })

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
      const artifactContainer = artifact?.closest(
        '.n-layout-sider-scroll-container',
      )
      const heading = document.querySelector('.conversation-header h1')
      const composer = document.querySelector('.message-input-area')
      const composerToolbar = document.querySelector('.message-input-toolbar')
      if (
        !pane ||
        !scroll ||
        !artifact ||
        !artifactContainer ||
        !heading ||
        !composer ||
        !composerToolbar
      ) {
        throw new Error('Expected application layout elements')
      }
      const paneRect = pane.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      const artifactRect = artifact.getBoundingClientRect()
      const artifactContainerRect = artifactContainer.getBoundingClientRect()
      const titleRect = heading.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      const toolbarRect = composerToolbar.getBoundingClientRect()
      return {
        paneRight: paneRect.right,
        scrollRight: scrollRect.right,
        titleRight: titleRect.right,
        composerRight: composerRect.right,
        toolbarRight: toolbarRect.right,
        artifactLeft: artifactRect.left,
        artifactRight: artifactRect.right,
        artifactContainerRight: artifactContainerRect.right,
        artifactPosition: getComputedStyle(artifact).position,
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
      }
    })

    expect(metrics.artifactPosition).not.toBe('absolute')
    const artifactLeftBoundary = metrics.artifactLeft + 0.5
    expect(metrics.paneRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.scrollRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.titleRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.composerRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.toolbarRight).toBeLessThanOrEqual(artifactLeftBoundary)
    expect(metrics.artifactContainerRight - metrics.artifactRight).toBe(0)
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth)
  })

  test('keeps legacy Markdown import disabled without a placeholder export', async () => {
    fakeProvider.queue([textDelta('Import and export fixture ready.')])
    await startDurableSession({
      page,
      workspace,
      title: 'Import and export fixture',
      message: 'create the import and export fixture',
    })
    await page.reload()
    await page
      .getByRole('button', { name: 'Import and export fixture', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: '从 Markdown 导入' }),
    ).toBeDisabled()
    await expect(
      page.getByRole('button', { name: '导出为 Markdown' }),
    ).toHaveCount(0)
  })
})
