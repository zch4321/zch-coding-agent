import { _electron as electron, expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentApi } from '../shared/agent-api'
import { configureApp } from './support/app-helpers'
import {
  cleanEnvironment,
  closeElectronApplication,
} from './support/electron-harness'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
} from './support/feature-harness'
import { textDelta } from './support/fake-provider'

test('restores independent Session drafts, attachment references and the new-session placeholder across reload and restart', async () => {
  test.setTimeout(120_000)
  const harness = await launchFeatureHarness()
  try {
    let page = harness.page
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await writeFile(
      path.join(harness.workspace, 'notes.md'),
      'Draft attachment contents',
    )
    await configureApp({
      page,
      providerBaseURL: harness.fakeProvider.origin,
      workspace: harness.workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    for (const name of ['Draft session A', 'Draft session B']) {
      harness.fakeProvider.queue([textDelta(`Reply for ${name}`)])
      await page.locator('.new-conversation-button').click()
      await page.locator('.message-input-area textarea').fill(name)
      await page.getByRole('button', { name: '发送消息' }).click()
      await expect(
        page.locator('.chat-message.assistant').last(),
      ).toContainText(`Reply for ${name}`)
      await expect(page.locator('.message-input-area textarea')).toHaveValue('')
    }
    await page
      .locator('.conversation-item')
      .filter({ hasText: 'Draft session A' })
      .click()
    const composer = page.locator('.message-input-area textarea')
    await composer.fill('@notes.md')
    await expect(page.locator('.composer-suggestions')).toContainText(
      'notes.md',
    )
    await composer.press('Enter')
    await expect(page.locator('.composer-context-chips')).toContainText(
      'notes.md',
    )
    await composer.fill('A 未发送的内容')
    await page
      .locator('.conversation-item')
      .filter({ hasText: 'Draft session B' })
      .click()
    await expect(composer).toHaveValue('')
    await composer.fill('B unfinished draft')
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(composer).toHaveValue('B unfinished draft')
    await page
      .locator('.conversation-item')
      .filter({ hasText: 'Draft session A' })
      .click()
    await expect(composer).toHaveValue('A 未发送的内容')
    await expect(page.locator('.composer-context-chips')).toContainText(
      'notes.md',
    )

    await page.locator('.new-conversation-button').click()
    await composer.fill('New conversation kept on restart')
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(composer).toHaveValue('New conversation kept on restart')
    await expect(page.locator('.conversation-row.active')).toHaveCount(0)
    await expect(page.locator('.conversation-item')).toHaveCount(2)
    await composer.fill('Last edit before closing')
    await closeElectronApplication(harness)
    harness.electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${harness.userDataPath}`],
      env: cleanEnvironment(),
    })
    harness.electronProcess = harness.electronApp.process()
    harness.page = await harness.electronApp.firstWindow()
    page = harness.page
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(page.locator('.message-input-area textarea')).toHaveValue(
      'Last edit before closing',
    )
    await expect(page.locator('.conversation-row.active')).toHaveCount(0)
    await page
      .locator('.conversation-item')
      .filter({ hasText: 'Draft session A' })
      .click()
    await expect(page.locator('.message-input-area textarea')).toHaveValue(
      'A 未发送的内容',
    )
    await expect(page.locator('.composer-context-chips')).toContainText(
      'notes.md',
    )

    const durableText = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as AgentApi
      const bootstrap = await api.getBootstrap({ version: 1 })
      if (!bootstrap.ok) throw new Error(bootstrap.error.message)
      const snapshots = await Promise.all(
        bootstrap.value.sessionPage.records.map((session) =>
          api.getSession({ version: 1, sessionId: session.id }),
        ),
      )
      return JSON.stringify(snapshots)
    })
    expect(durableText).not.toContain('A 未发送的内容')
    expect(durableText).not.toContain('B unfinished draft')
    expect(durableText).not.toContain('Last edit before closing')
  } finally {
    await disposeFeatureHarness(harness)
  }
})
