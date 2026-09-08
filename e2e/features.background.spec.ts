import { expect, test } from '@playwright/test'
import type { AgentApi } from '../shared/agent-api'
import { configureApp } from './support/app-helpers'
import {
  textDelta,
  toolCallDelta,
  providerToolNames,
} from './support/fake-provider'
import {
  launchFeatureHarness,
  disposeFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

test.describe('Background sidebar', () => {
  let harness: FeatureHarness
  test.beforeEach(async () => {
    harness = await launchFeatureHarness()
    await expect(harness.page.getByTestId('app-ready')).toBeVisible()
  })
  test.afterEach(async () => {
    await disposeFeatureHarness(harness)
  })

  test('tails an existing terminal without opening the bottom panel and preserves interactive access', async () => {
    test.skip(
      process.platform !== 'win32',
      'Uses the Windows command-shell profile',
    )
    const { page, fakeProvider, workspace } = harness
    fakeProvider.queue([textDelta('Background terminal fixture ready.')])
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'auto',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Prepare the conversation.')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Background terminal fixture ready.',
    )

    const target = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as AgentApi
      const bootstrap = await api.getBootstrap({ version: 1 })
      if (!bootstrap.ok) throw new Error(bootstrap.error.message)
      const sessionId = bootstrap.value.sessionPage.records[0]!.id
      const opened = await api.openTerminal({ version: 1, sessionId })
      if (!opened.ok) throw new Error(opened.error.message)
      const terminalId = opened.value.terminal.terminalId
      const sent = await api.sendTerminalInput({
        version: 1,
        sessionId,
        terminalId,
        data: "[Console]::WriteLine(('BG_ARTIFACT_' + (3 + 4)))\r",
      })
      if (!sent.ok) throw new Error(sent.error.message)
      return { sessionId, terminalId }
    })
    await expect(page.locator('.terminal-panel')).toBeHidden()
    await page
      .getByRole('button', { name: '切换右侧栏（Ctrl+Shift+B）' })
      .click()
    await page.getByRole('tab', { name: /后台/u }).click()
    const card = page.locator('.agent-execution-item', {
      hasText: `终端 ${target.terminalId}`,
    })
    await card.locator('.n-collapse-item__header-main').click()
    await expect(card.locator('.background-log-text')).toContainText(
      'BG_ARTIFACT_7',
      { timeout: 30000 },
    )
    await expect
      .poll(() =>
        card.locator('.background-log-scroll').evaluate((node) => {
          const log = node.getBoundingClientRect()
          const clip = node
            .closest('.n-collapse-item__content-wrapper')!
            .getBoundingClientRect()
          return log.height >= 40 && log.bottom <= clip.bottom + 1
        }),
      )
      .toBe(true)
    await expect(page.locator('.terminal-panel')).toBeHidden()
    expect(
      await page.evaluate(async ({ sessionId }) => {
        const result = await (
          Reflect.get(window, 'agentApi') as AgentApi
        ).listTerminals({ version: 1, sessionId })
        if (!result.ok) throw new Error(result.error.message)
        return result.value.terminals.length
      }, target),
    ).toBe(1)
    await page.screenshot({
      path: test.info().outputPath('background-terminal.png'),
      animations: 'disabled',
    })

    await page.getByRole('button', { name: /切换终端/u }).click()
    const input = page.locator(
      '.terminal-surface:visible .xterm-helper-textarea',
    )
    await input.focus()
    await page.keyboard.type("[Console]::WriteLine(('BOTTOM_' + (8 + 1)))")
    await page.keyboard.press('Enter')
    await expect(
      page.locator('.terminal-surface:visible .xterm-rows'),
    ).toContainText('BOTTOM_9', { timeout: 30000 })
    await expect(card.locator('.background-log-text')).toContainText('BOTTOM_9')
    await page.getByRole('button', { name: /切换终端/u }).click()
    await card.getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(card.locator('.agent-execution-heading')).toContainText(
      '已关闭',
    )
    await expect(card.locator('.background-log-text')).toContainText('BOTTOM_9')
    await expect(page.locator('.terminal-panel')).toBeHidden()
  })

  test('stops a detached Swarm from its collapsed root after the parent has finished', async () => {
    const { page, fakeProvider, workspace } = harness
    const parentRequest = (request: { body: Record<string, unknown> }) =>
      providerToolNames(request.body).includes('swarm_run')
    fakeProvider.armResponseGate([])
    fakeProvider.queue(
      [
        toolCallDelta({
          id: 'call:background-swarm',
          name: 'swarm_run',
          args: {
            sharedContext: 'Exercise the background cancellation UI.',
            tasks: [
              {
                name: 'cancel-workers',
                task: 'Keep working until stopped.',
                requiredCapability: 'standard',
                agentCount: 2,
                toolAccess: 'readonly',
              },
            ],
          },
        }),
      ],
      { match: parentRequest },
    )
    fakeProvider.queue([textDelta('Child one is waiting.')], {
      match: (request) => !parentRequest(request),
      gate: true,
    })
    fakeProvider.queue([textDelta('Child two is waiting.')], {
      match: (request) => !parentRequest(request),
      gate: true,
    })
    fakeProvider.queue([textDelta('Parent finished; workers continue.')], {
      match: parentRequest,
    })
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      swarm: true,
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Start a Swarm with two background workers.')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Parent finished; workers continue.',
    )
    await page
      .getByRole('button', { name: '切换右侧栏（Ctrl+Shift+B）' })
      .click()
    await page.getByRole('tab', { name: /后台/u }).click()
    const card = page.locator('.agent-execution-item').first()
    await expect(card).not.toHaveClass(/n-collapse-item--active/u)
    await card.getByRole('button', { name: '停止', exact: true }).click()
    await expect(card).not.toHaveClass(/n-collapse-item--active/u)
    await expect(card.locator('.agent-execution-heading')).toContainText(
      '已取消',
    )
    await card.locator('.n-collapse-item__header-main').click()
    await expect(card.locator('.agent-execution-child-item')).toHaveCount(2)
    for (const child of await card.locator('.agent-execution-child-item').all())
      await expect(child).toContainText('已取消')
  })
})
