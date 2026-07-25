import { expect, test, type Page } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp, findDurableMessageText } from './support/app-helpers'
import {
  providerMessageText,
  textDelta,
  toolCallDelta,
  type FakeProvider,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

test.describe('Electron concurrency and interjection workflows', () => {
  let harness: FeatureHarness
  let fakeProvider: FakeProvider
  let page: Page
  let userDataPath: string
  let workspace: string

  test.beforeEach(async () => {
    harness = await launchFeatureHarness()
    ;({ fakeProvider, page, userDataPath, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterEach(async () => disposeFeatureHarness(harness))

  test('keeps one writer and a concurrent readonly conversation in the same workspace', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-writer-lock',
        name: 'create_file',
        args: {
          path: 'writer-lock.txt',
          content: 'writer lock fixture\n',
          _agent_intent: 'Hold the workspace writer at approval',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Readonly B completed beside writer A.')])
    fakeProvider.queue([textDelta('Writer A stopped without changing files.')])
    fakeProvider.queue([textDelta('B became the next writer.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
      traceLogging: true,
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Create writer lock fixture')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    await expect(page.locator('.approval-card')).toBeVisible()

    await page.locator('.new-conversation-button').click()
    const modeSelect = page.locator('.mode-select')
    await expect(modeSelect).toContainText('只读')
    await expect(modeSelect.locator('.n-base-selection--disabled')).toHaveCount(
      1,
    )
    await expect(page.locator('.approval-card')).toHaveCount(0)
    await expect(page.locator('.project-sidebar')).toContainText('待审批')

    await composer.fill('Analyze while A writes')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Readonly B completed beside writer A.',
    )
    expect(providerMessageText(fakeProvider.requests[1].body)).toContain(
      '<workspace_concurrency status="readonly_locked">',
    )
    expect(providerMessageText(fakeProvider.requests[1].body)).toContain(
      '另一个 agent run 正在修改同一 workspace',
    )

    await page
      .locator('button.conversation-item', {
        hasText: 'Create writer lock fixture',
      })
      .click()
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(3)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Writer A stopped without changing files.',
    )
    expect(
      await readFile(path.join(workspace, 'writer-lock.txt'), 'utf8').catch(
        () => 'missing',
      ),
    ).toBe('missing')

    await page
      .locator('button.conversation-item', {
        hasText: 'Analyze while A writes',
      })
      .click()
    await expect(modeSelect).toContainText('只读')
    await expect(modeSelect.locator('.n-base-selection--disabled')).toHaveCount(
      0,
    )
    await modeSelect.click()
    await page.getByText('确认', { exact: true }).last().click()
    await expect(modeSelect).toContainText('确认')

    await composer.fill('Take the writer after A')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(4)
    await expect(
      page.locator('.chat-message.assistant', {
        hasText: 'B became the next writer.',
      }),
    ).toBeVisible()
    expect(providerMessageText(fakeProvider.requests[3].body)).toContain(
      '<workspace_concurrency status="writer">',
    )

    await expect
      .poll(async () => {
        const traceDirectory = path.join(userDataPath, 'traces')
        const files = (await readdir(traceDirectory)).filter((file) =>
          file.endsWith('.jsonl'),
        )
        const traces = await Promise.all(
          files.map((file) =>
            readFile(path.join(traceDirectory, file), 'utf8'),
          ),
        )
        return traces.join('\n')
      })
      .toContain('"type":"workspace.writer"')
  })

  test('injects a live user interjection after a tool batch mid-run', async () => {
    // First provider turn: a create_file tool call that requires approval in
    // confirm mode. Second provider turn: a final answer that acknowledges the
    // queued interjection. The approval pause gives the test a deterministic
    // window to queue the interjection before the second provider turn.
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-interject-write',
        name: 'create_file',
        args: {
          path: 'interject-output.txt',
          content: 'interjection run\n',
          _agent_intent: 'Create an output file',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Done after the live interjection.')])

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
    await composer.fill('Create interject-output.txt')
    await page.getByRole('button', { name: '发送消息' }).click()

    // The create_file tool call requires approval, so the run pauses. This is
    // the deterministic window to queue a live interjection.
    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('create_file')

    await expect(composer).toBeEnabled()
    await composer.fill('Remember to mention the interjection')
    await page.getByRole('button', { name: '发送插话' }).click()

    // The interjection appears as a distinct timeline message while the run is
    // still paused on the approval.
    await expect(
      page.locator('.chat-message.interjection').first(),
    ).toContainText('Remember to mention the interjection')

    // Approve the write so the tool batch completes; the queued interjection
    // is then injected before the second provider continuation.
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    // The run continues (a second provider request fires) and finishes.
    await expect
      .poll(() => fakeProvider.requests.length, { timeout: 15_000 })
      .toBe(2)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Done after the live interjection.',
    )

    const secondRequest = fakeProvider.requests[1]
    const secondRequestBody = JSON.stringify(secondRequest.body)
    expect(secondRequestBody).toContain('<live_user_interjection>')
    expect(secondRequestBody).toContain('Remember to mention the interjection')

    // The interjection user message must come after the tool result, never
    // interleaved between the assistant tool_call and its tool_result.
    const messages =
      (secondRequest.body.messages as Array<{
        role?: string
        content?: string
      }>) ?? []
    const toolResultIndex = messages.findIndex(
      (message) => message.role === 'tool',
    )
    const interjectionIndex = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<live_user_interjection>'),
    )
    expect(toolResultIndex).toBeGreaterThanOrEqual(0)
    expect(interjectionIndex).toBeGreaterThan(toolResultIndex)

    // The Durable Session stores the interjection message.
    await expect
      .poll(() =>
        findDurableMessageText(
          page,
          'Create interject-output.txt',
          'interjection',
        ),
      )
      .toBe('Remember to mention the interjection')
  })
})
