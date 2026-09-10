import {
  _electron as electron,
  expect,
  test,
  type Page,
} from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentApi } from '../shared/agent-api'
import { configureApp } from './support/app-helpers'
import { textDelta, toolCallDelta } from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
} from './support/feature-harness'
import {
  cleanEnvironment,
  closeElectronApplication,
} from './support/electron-harness'

async function selectedUsage(page: Page) {
  return page.evaluate(async () => {
    const api = Reflect.get(window, 'agentApi') as AgentApi
    const bootstrap = await api.getBootstrap({ version: 1 })
    if (!bootstrap.ok) throw new Error(bootstrap.error.message)
    const session = bootstrap.value.sessionPage.records[0]
    if (!session) return undefined
    const usage = await api.getSessionUsage({
      version: 1,
      sessionId: session.id,
    })
    if (!usage.ok) throw new Error(usage.error.message)
    return usage.value
  })
}

test('shows context sources and persistent usage while preserving the header across reload and app restart', async ({
  browserName,
}, testInfo) => {
  void browserName
  test.setTimeout(120_000)
  const harness = await launchFeatureHarness()
  try {
    let page = harness.page
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await configureApp({
      page,
      providerBaseURL: harness.fakeProvider.origin,
      workspace: harness.workspace,
      defaultMode: 'readonly',
      traceLogging: false,
    })
    await writeFile(
      path.join(harness.workspace, 'usage.txt'),
      'Context usage fixture',
    )
    harness.fakeProvider.queue([
      {
        ...toolCallDelta({
          id: 'call:usage-read',
          name: 'read_file',
          args: { path: 'usage.txt', _agent_intent: 'Read the fixture' },
        }),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 12,
          prompt_cache_hit_tokens: 20,
        },
      },
    ])
    harness.fakeProvider.queue([
      textDelta('Usage fixture complete.', {
        prompt_tokens: 140,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 30,
      }),
    ])
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Read usage.txt and summarize it')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant').last()).toContainText(
      'Usage fixture complete.',
    )
    await expect
      .poll(async () => (await selectedUsage(page))?.all.totals.calls)
      .toBe(2)
    const first = (await selectedUsage(page))!
    expect(first.all.totals).toMatchObject({
      promptTokens: 240,
      completionTokens: 32,
      cacheHitTokens: 50,
      cacheMissTokens: 190,
    })
    for (const category of [
      'system',
      'user',
      'assistant',
      'toolDefinitions',
      'toolCalls',
      'toolResults',
    ]) {
      expect(
        first.context?.categories.find((group) => group.category === category)
          ?.tokens,
      ).toBeGreaterThan(0)
    }
    await expect(page.locator('.usage-summary')).toContainText('输出 32')
    const header = await page.locator('.usage-summary').innerText()
    const toggle = page.getByRole('button', {
      name: '切换右侧栏（Ctrl+Shift+B）',
    })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true')
      await toggle.click()
    await page.getByRole('tab', { name: '用量', exact: true }).click()
    const panel = page.getByTestId('usage-tab')
    await expect(
      panel.getByRole('heading', { name: '当前上下文' }),
    ).toBeVisible()
    await expect(panel.getByRole('heading', { name: '用量明细' })).toBeVisible()
    await panel.getByText('主对话', { exact: true }).click()
    await panel.getByText('按模型', { exact: true }).click()
    await expect(panel.locator('.usage-model-title')).toContainText(
      'e2e-functional-model',
    )
    await panel.getByText('用户输入', { exact: true }).click()
    await expect(panel.locator('.usage-entry')).toContainText('用户消息')
    await page.screenshot({ path: testInfo.outputPath('usage-sidebar.png') })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(page.locator('.usage-summary')).toHaveText(header, {
      useInnerText: true,
    })
    expect((await selectedUsage(page))?.context).toEqual(first.context)
    harness.fakeProvider.queue([
      textDelta('Second run complete.', {
        prompt_tokens: 80,
        completion_tokens: 8,
        prompt_cache_hit_tokens: 10,
      }),
    ])
    await page
      .locator('.message-input-area textarea')
      .fill('Continue with a short answer')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant').last()).toContainText(
      'Second run complete.',
    )
    await expect
      .poll(async () => (await selectedUsage(page))?.all.totals.calls)
      .toBe(3)
    const second = (await selectedUsage(page))!
    expect(second.currentRun?.summary.totals).toMatchObject({
      calls: 1,
      promptTokens: 80,
      completionTokens: 8,
    })
    await expect(page.locator('.usage-summary')).toContainText('输出 8')
    const secondHeader = await page.locator('.usage-summary').innerText()
    await closeElectronApplication(harness)
    harness.electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${harness.userDataPath}`],
      env: cleanEnvironment(),
    })
    harness.electronProcess = harness.electronApp.process()
    harness.page = await harness.electronApp.firstWindow()
    page = harness.page
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(page.locator('.usage-summary')).toHaveText(secondHeader, {
      useInnerText: true,
    })
    expect(await selectedUsage(page)).toEqual(second)
  } finally {
    await disposeFeatureHarness(harness)
  }
})
