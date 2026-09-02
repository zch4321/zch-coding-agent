import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp, findDurableMessageText } from './support/app-helpers'
import {
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
  let workspace: string

  test.beforeEach(async () => {
    harness = await launchFeatureHarness()
    ;({ fakeProvider, page, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterEach(async () => disposeFeatureHarness(harness))

  test('allows concurrent write-capable conversations in the same workspace', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-concurrent-a',
        name: 'write_file',
        args: {
          path: 'concurrent-a.txt',
          content: 'written by conversation A\n',
          _agent_intent: 'Write the output owned by conversation A',
        },
      }),
    ])
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-concurrent-b',
        name: 'write_file',
        args: {
          path: 'concurrent-b.txt',
          content: 'written by conversation B\n',
          _agent_intent: 'Write the output owned by conversation B',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Concurrent write completed.')])
    fakeProvider.queue([textDelta('Concurrent write completed.')])
    fakeProvider.armResponseGate([1, 2])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'yolo',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Write the output owned by conversation A')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(1)

    await page.locator('.new-conversation-button').click()
    const modeSelect = page.locator('.mode-select')
    await expect(modeSelect).toContainText('全自动')
    await expect(modeSelect.locator('.n-base-selection--disabled')).toHaveCount(
      0,
    )

    await composer.fill('Write the output owned by conversation B')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    expect(JSON.stringify(fakeProvider.requests[0].body)).not.toContain(
      'workspace_concurrency',
    )
    expect(JSON.stringify(fakeProvider.requests[1].body)).not.toContain(
      'workspace_concurrency',
    )

    fakeProvider.releaseResponseGate()
    await expect.poll(() => fakeProvider.requests.length).toBe(4)
    await expect
      .poll(() =>
        readFile(path.join(workspace, 'concurrent-a.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('written by conversation A\n')
    await expect
      .poll(() =>
        readFile(path.join(workspace, 'concurrent-b.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('written by conversation B\n')
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Concurrent write completed.',
    )
  })

  test('injects a live user interjection after a tool batch mid-run', async () => {
    // First provider turn: a write_file tool call that requires approval in
    // confirm mode. Second provider turn: a final answer that acknowledges the
    // queued interjection. The approval pause gives the test a deterministic
    // window to queue the interjection before the second provider turn.
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-interject-write',
        name: 'write_file',
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

    // The write_file tool call requires approval, so the run pauses. This is
    // the deterministic window to queue a live interjection.
    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('write_file')

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
      .poll(() => fakeProvider.requests.length, { timeout: 30_000 })
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
