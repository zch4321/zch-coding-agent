import { _electron as electron, expect, test } from '@playwright/test'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { AgentApi } from '../shared/agent-api'
import { configureApp, latestTrace } from './support/app-helpers'
import {
  cleanEnvironment,
  closeElectronApplication,
} from './support/electron-harness'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
} from './support/feature-harness'
import { textDelta } from './support/fake-provider'

test('persists imported image/file drafts through restart, sends native images and restores history previews', async () => {
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
      traceLogging: true,
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const image = path.join(harness.temporaryRoot, 'screenshot.png')
    const file = path.join(harness.temporaryRoot, 'notes.txt')
    await sharp({
      create: { width: 640, height: 420, channels: 3, background: '#3685aa' },
    })
      .png()
      .toFile(image)
    await writeFile(file, 'Local attachment snapshot')
    await page.getByRole('button', { name: '添加内容', exact: true }).click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByText('添加附件', { exact: true }).click()
    await (await fileChooser).setFiles([image, file])
    const previews = page.locator('.message-input-area .attachment-preview')
    await expect(previews).toHaveCount(2)
    await expect(previews.locator('img')).toBeVisible()
    await expect
      .poll(() =>
        previews
          .locator('img')
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    await rm(image)
    await rm(file)
    await closeElectronApplication(harness)
    harness.electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${harness.userDataPath}`],
      env: cleanEnvironment(),
    })
    harness.electronProcess = harness.electronApp.process()
    harness.page = await harness.electronApp.firstWindow()
    page = harness.page
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(2)
    harness.fakeProvider.armResponseGate([1])
    harness.fakeProvider.queue([textDelta('The image and local file arrived.')])
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => harness.fakeProvider.requests.length).toBe(1)
    await page.getByRole('button', { name: '添加内容', exact: true }).click()
    const disabledContextOptions = page.locator(
      '.n-dropdown-option-body--disabled',
    )
    await expect(disabledContextOptions).toHaveText([
      '添加文件上下文',
      '添加目录上下文',
    ])
    const draftFileChooser = page.waitForEvent('filechooser')
    await page.getByText('添加附件', { exact: true }).click()
    await (await draftFileChooser).setFiles([])
    harness.fakeProvider.releaseResponseGate()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'The image and local file arrived.',
    )
    await expect(
      page.locator('.chat-message.user .attachment-preview'),
    ).toHaveCount(2)
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(0)
    await expect(page.locator('.message-input-area textarea')).toHaveValue('')
    const wire = JSON.stringify(harness.fakeProvider.requests[0].body)
    expect(wire).toContain('data:image/jpeg;base64,')
    expect(wire).toContain('notes.txt')
    const trace = await latestTrace(harness)
    expect(trace.raw).not.toContain('data:image/')
    expect(trace.raw).toContain('zch-image:')
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('.chat-message.user img')
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    await page
      .locator('.chat-message.user')
      .getByRole('button', { name: '重新附加', exact: true })
      .first()
      .click()
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(1)
    await expect(
      page.getByRole('button', { name: '发送消息', exact: true }),
    ).toBeInViewport()
    await page.screenshot({ path: 'test-results/attachment-previews.png' })
  } finally {
    await disposeFeatureHarness(harness)
  }
})

test('handles screenshot paste and file drop while unsupported models retain their image drafts', async () => {
  const harness = await launchFeatureHarness()
  try {
    const { page } = harness
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await configureApp({
      page,
      providerBaseURL: harness.fakeProvider.origin,
      workspace: harness.workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const png = await sharp({
      create: { width: 60, height: 40, channels: 3, background: '#ff8844' },
    })
      .png()
      .toBuffer()
    const prevented = await page.evaluate((bytes) => {
      const data = new DataTransfer()
      data.items.add(
        new File([new Uint8Array(bytes)], 'pasted-image.png', {
          type: 'image/png',
        }),
      )
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      })
      document
        .querySelector('.message-input-area textarea')!
        .dispatchEvent(event)
      return event.defaultPrevented
    }, Array.from(png))
    expect(prevented).toBe(true)
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(1)
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(
        new File(['dropped notes'], 'dropped.txt', { type: 'text/plain' }),
      )
      document.querySelector('.message-input-area')!.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      )
    })
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(2)
    expect(
      await page.evaluate(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'plain text')
        const event = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
        document
          .querySelector('.message-input-area textarea')!
          .dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(false)
    const configured = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as AgentApi
      const result = await api.getConfig({ version: 1, section: 'providers' })
      if (!result.ok) return false
      const provider = result.value.config.models.providers.find(
        (candidate) => candidate.id === 'deepseek',
      )!
      return (
        await api.setConfig({
          version: 1,
          kind: 'provider-settings',
          providerId: provider.id,
          baseURL: provider.baseURL,
          model: provider.model,
          modelOverrides: {
            ...provider.modelOverrides,
            [provider.model]: {
              ...provider.modelOverrides[provider.model],
              imageInput: 'unsupported',
            },
          },
        })
      ).ok
    })
    expect(configured).toBe(true)
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(
      page.getByRole('button', { name: '发送消息', exact: true }),
    ).toBeDisabled()
    await expect(
      page.locator('.message-input-area .attachment-preview'),
    ).toHaveCount(2)
    await expect(page.locator('.conversation-item')).toHaveCount(0)
    expect(harness.fakeProvider.requests).toHaveLength(0)
  } finally {
    await disposeFeatureHarness(harness)
  }
})
