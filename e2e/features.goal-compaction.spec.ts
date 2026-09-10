import { expect, test, type Page } from '@playwright/test'
import type { AgentApi } from '../shared/agent-api'
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

/** Reads the persisted checkpoint rather than relying on its transient streamed text. */
async function compactCheckpoint(page: Page) {
  return page.evaluate(async () => {
    const api = Reflect.get(window, 'agentApi') as AgentApi
    const bootstrap = await api.getBootstrap({ version: 1 })
    if (!bootstrap.ok) throw new Error(bootstrap.error.message)
    const session = bootstrap.value.sessionPage.records[0]
    if (!session) return undefined
    const result = await api.getSession({ version: 1, sessionId: session.id })
    if (!result.ok) throw new Error(result.error.message)
    return result.value.snapshot.messagePage.records.find(
      (record) => record.kind === 'compact_summary',
    )
  })
}

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

  for (const followUp of ['', 'keep e2e compact details']) {
    test(`compacts history ${followUp ? 'with an immediate follow-up' : 'without a follow-up'} and records prompt metadata`, async () => {
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

      await composer.fill(followUp ? `/compact ${followUp}` : '/compact')
      await page.getByRole('button', { name: '发送消息' }).click()
      await expect
        .poll(() => compactCheckpoint(page))
        .toMatchObject({
          kind: 'compact_summary',
          visibility: 'hidden',
          inHistory: true,
          parts: [
            {
              type: 'provider_compact',
              payload: {
                format: 'summary-text.v1',
                data: { text: 'E2E compact summary retained.' },
              },
            },
          ],
        })
      if (!followUp) {
        expect(fakeProvider.requests).toHaveLength(2)
        await composer.fill('Continue after compact')
        await page.getByRole('button', { name: '发送消息' }).click()
      }
      await expect(
        page.locator('.chat-message.assistant', {
          hasText: 'After compact answer.',
        }),
      ).toBeVisible()
      await expect.poll(() => fakeProvider.requests.length).toBe(3)

      const afterCompactText = providerMessageText(
        fakeProvider.requests[2].body,
      )
      expect(afterCompactText).not.toContain('RAW_E2E_OLD_CONTEXT')
      expect(afterCompactText).toContain('<compact_history')
      expect(afterCompactText).toContain('E2E compact summary retained.')
      expect(afterCompactText).toContain('Orchestration state at compaction:')
      expect(afterCompactText).toContain('Goal: none')
      expect(afterCompactText).toContain('Plan: none')
      expect(afterCompactText).toContain(followUp || 'Continue after compact')

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
  }
})
