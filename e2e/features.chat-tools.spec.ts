import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp, findDurableMessageText } from './support/app-helpers'
import {
  providerApiKey,
  providerMessageText,
  providerModel,
  providerToolNames,
  textDelta,
  toolCallDelta,
  type FakeProvider,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

test.describe('Electron chat and tool workflows', () => {
  let harness: FeatureHarness
  let fakeProvider: FakeProvider
  let page: Page
  let workspace: string

  test.beforeEach(async () => {
    harness = await launchFeatureHarness()
    ;({ fakeProvider, page, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterEach(async () => disposeFeatureHarness(harness))

  test('sends workspace context to the provider and persists the assistant reply', async () => {
    await writeFile(
      path.join(workspace, 'notes.md'),
      'Important workspace note from the e2e fixture.\n',
    )
    fakeProvider.queue([
      textDelta('E2E provider saw '),
      textDelta('the workspace context.', {
        prompt_tokens: 11,
        completion_tokens: 6,
        total_tokens: 17,
      }),
    ])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await expect(composer).toBeEnabled()
    await composer.fill('Summarize @notes.md')
    await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect(page.locator('.chat-message.user')).toContainText(
      'Summarize @notes.md',
    )
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'E2E provider saw the workspace context.',
    )
    await expect.poll(() => fakeProvider.requests.length).toBe(1)

    const request = fakeProvider.requests[0]
    expect(request.authorization).toBe(`Bearer ${providerApiKey}`)
    expect(request.body).toMatchObject({
      model: providerModel,
      stream: true,
    })
    expect(providerToolNames(request.body)).toEqual(
      expect.arrayContaining(['read_file', 'create_file']),
    )
    const requestMessages = providerMessageText(request.body)
    expect(requestMessages).toContain('<context_file path="notes.md"')
    expect(requestMessages).toContain(
      'Important workspace note from the e2e fixture',
    )
    expect(requestMessages).toContain('Summarize @notes.md')

    await expect
      .poll(() =>
        findDurableMessageText(page, 'Summarize @notes.md', 'assistant_turn'),
      )
      .toBe('E2E provider saw the workspace context.')
  })

  test('approves a create_file tool call and continues the provider turn', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-write',
        name: 'create_file',
        args: {
          path: 'e2e-output.txt',
          content: 'approved by e2e\n',
          _agent_intent: 'Create an e2e output file',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Created e2e-output.txt')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await expect(composer).toBeEnabled()
    await composer.fill('Create e2e-output.txt')
    await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('create_file')
    await expect(approval).toContainText('e2e-output.txt')
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    await expect
      .poll(async () =>
        readFile(path.join(workspace, 'e2e-output.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('approved by e2e\n')
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(
      page.locator('.tool-call-card', { hasText: 'create_file' }),
    ).toContainText('已完成')
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Created e2e-output.txt',
    )

    const firstRequest = fakeProvider.requests[0]
    const secondRequest = fakeProvider.requests[1]
    expect(providerToolNames(firstRequest.body)).toContain('create_file')
    const secondRequestBody = JSON.stringify(secondRequest.body)
    expect(secondRequestBody).toContain('"role":"tool"')
    expect(secondRequestBody).toContain('"tool_call_id":"call:e2e-write"')
    expect(providerMessageText(secondRequest.body)).toContain(
      '"path":"e2e-output.txt"',
    )
  })

  test('contains a 20,000-character tool result inside the tool card', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-long-output',
        name: 'run_command',
        args: {
          mode: 'process',
          executable: 'node',
          args: ['-e', "process.stdout.write('x'.repeat(20000))"],
        },
      }),
    ])
    fakeProvider.queue([textDelta('Long output checked.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Produce one long tool result')
    await page.getByRole('button', { name: '发送消息' }).click()
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    const card = page.locator('.tool-call-card', {
      hasText: 'run_command',
    })
    await expect(card).toContainText('已完成')
    await card.locator('.tool-call-row').click()
    await expect(card.locator('.tool-result-json')).toBeVisible()
    const metrics = await card.evaluate((element) => {
      const pane = document.querySelector('.conversation-pane')
      const scroll = document.querySelector('.conversation-scroll')
      const result = element.querySelector('.tool-result-json')
      if (!pane || !scroll || !result) {
        throw new Error('Expected tool result layout')
      }
      const paneRect = pane.getBoundingClientRect()
      const cardRect = element.getBoundingClientRect()
      return {
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        paneLeft: paneRect.left,
        paneRight: paneRect.right,
        outerClientWidth: scroll.clientWidth,
        outerScrollWidth: scroll.scrollWidth,
        resultClientWidth: result.clientWidth,
        resultScrollWidth: result.scrollWidth,
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
