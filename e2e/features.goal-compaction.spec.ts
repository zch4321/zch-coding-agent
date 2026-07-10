import { expect, test, type Page } from '@playwright/test'
import {
  configureApp,
  latestTrace,
  setAssistantLanguage,
} from './support/app-helpers'
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

test.describe('Electron goal and compaction workflows', () => {
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

  test('uses the English /goal prompt and updates the goal UI', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-goal-complete',
        name: 'goal_complete',
        args: {
          summary: 'Goal completed by e2e',
          evidence: 'The fake provider called goal_complete.',
          remainingRisks: 'none',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Goal finished in English.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      assistantLanguage: 'en-US',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await setAssistantLanguage(page, 'en-US')

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('/goal Finish the English prompt harness check')
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect
      .poll(() => fakeProvider.requests.length)
      .toBeGreaterThanOrEqual(1)
    const firstRequestText = providerMessageText(fakeProvider.requests[0].body)
    expect(firstRequestText).toContain('Start and pursue this Goal')
    expect(firstRequestText).toContain(
      'Finish the English prompt harness check',
    )
    expect(firstRequestText).toContain('goal_complete')

    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    const goalPanel = page.locator('.orchestration-card')
    await expect(goalPanel).toContainText(
      'Finish the English prompt harness check',
    )
    await expect(goalPanel).toContainText('completed')
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Goal finished in English.',
    )
  })

  test('compacts history and records compact prompt metadata in trace', async () => {
    fakeProvider.queue([textDelta('Old raw answer.')])
    fakeProvider.queue([textDelta('E2E compact summary retained.')])
    fakeProvider.queue([textDelta('After compact answer.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      traceLogging: true,
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('RAW_E2E_OLD_CONTEXT should disappear')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Old raw answer.',
    )

    await composer.fill('/compact keep e2e compact details')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(
      page.locator('.chat-message.assistant', {
        hasText: 'E2E compact summary retained.',
      }),
    ).toBeVisible()

    await composer.fill('Continue after compact')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(
      page.locator('.chat-message.assistant', {
        hasText: 'After compact answer.',
      }),
    ).toBeVisible()
    await expect.poll(() => fakeProvider.requests.length).toBe(3)

    const afterCompactText = providerMessageText(fakeProvider.requests[2].body)
    expect(afterCompactText).not.toContain('RAW_E2E_OLD_CONTEXT')
    expect(afterCompactText).toContain('<compact_history')
    expect(afterCompactText).toContain('E2E compact summary retained.')
    expect(afterCompactText).toContain('Orchestration state at compaction:')
    expect(afterCompactText).toContain('Goal: none')
    expect(afterCompactText).toContain('Plan: none')

    const trace = await latestTrace({ userDataPath })
    const compactEvent = trace.events.find(
      (event) =>
        event.type === 'orchestrator.message' && event.kind === 'compact',
    )
    expect(compactEvent).toMatchObject({
      promptId: 'orchestration.compact.zh-CN',
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
  })
})
