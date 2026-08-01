import { expect, test, type Locator, type Page } from '@playwright/test'
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
  toolCallsDelta,
  type FakeProvider,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

async function expandLatestToolGroup(page: Page): Promise<Locator> {
  const group = page.locator('.tool-call-group').last()
  await expect(group).toBeVisible()
  await group.locator('.n-collapse-item__header-main').first().click()
  return group
}

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
    const suggestions = page.locator('.composer-suggestions')
    await expect(suggestions).toBeVisible()
    await expect(suggestions).toContainText('notes.md')
    await composer.press('Escape')
    await expect(suggestions).toBeHidden()
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
    const liveToolGroup = await expandLatestToolGroup(page)
    const toolCard = liveToolGroup.locator('.tool-call-card', {
      hasText: 'create_file',
    })
    await expect(toolCard).toContainText('已完成')
    await toolCard.locator('.tool-call-row').click()
    const liveResultText = await toolCard
      .locator('.tool-result-json')
      .innerText()
    expect(liveResultText).toBe('Created file e2e-output.txt')
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
      'Created file e2e-output.txt',
    )

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const durableToolGroup = await expandLatestToolGroup(page)
    const durableToolCard = durableToolGroup.locator('.tool-call-card', {
      hasText: 'create_file',
    })
    await durableToolCard.locator('.tool-call-row').click()
    const durableResultText = await durableToolCard
      .locator('.tool-result-json')
      .innerText()
    expect(durableResultText).toBe(liveResultText)
    expect(durableResultText).not.toContain('call:e2e-write')
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

    const toolGroup = await expandLatestToolGroup(page)
    const card = toolGroup.locator('.tool-call-card', {
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

  test('shows same-batch approvals serially in one stable-height card', async () => {
    const longContent = 'second approval content line\n'.repeat(240)
    fakeProvider.queue([
      toolCallsDelta([
        {
          id: 'call:e2e-serial-first',
          name: 'create_file',
          args: {
            path: 'serial-first.txt',
            content: 'first approval\n',
            _agent_intent: 'Create the first serial approval fixture',
          },
        },
        {
          id: 'call:e2e-serial-second',
          name: 'create_file',
          args: {
            path: 'serial-second.txt',
            content: longContent,
            _agent_intent: 'Create the second serial approval fixture',
          },
        },
      ]),
    ])
    fakeProvider.queue([textDelta('Both serial approvals completed.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Create two files with serial approvals')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(1)

    const approvalCards = page.locator('.approval-card')
    const firstApproval = page.locator('.approval-card', {
      hasText: 'serial-first.txt',
    })
    await expect(approvalCards).toHaveCount(1)
    await expect(firstApproval).toBeVisible()
    const firstHeight = await firstApproval.evaluate(
      (element) => element.getBoundingClientRect().height,
    )

    await firstApproval
      .getByRole('button', { name: '批准', exact: true })
      .click()
    await expect(firstApproval).toHaveCount(0)

    const secondApproval = page.locator('.approval-card', {
      hasText: 'serial-second.txt',
    })
    await expect(secondApproval).toBeVisible()
    await expect(approvalCards).toHaveCount(1)
    const secondMetrics = await secondApproval.evaluate((element) => {
      const body = element.querySelector('.approval-card-body')
      if (!body) throw new Error('Expected approval body')
      return {
        height: element.getBoundingClientRect().height,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
      }
    })
    expect(Math.abs(secondMetrics.height - firstHeight)).toBeLessThanOrEqual(1)
    expect(secondMetrics.bodyScrollHeight).toBeGreaterThan(
      secondMetrics.bodyClientHeight,
    )

    await secondApproval
      .getByRole('button', { name: '批准', exact: true })
      .click()
    await expect(approvalCards).toHaveCount(0)
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Both serial approvals completed.',
    )
    await expect
      .poll(async () =>
        readFile(path.join(workspace, 'serial-first.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('first approval\n')
    await expect
      .poll(async () =>
        readFile(path.join(workspace, 'serial-second.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe(longContent)
  })
})
