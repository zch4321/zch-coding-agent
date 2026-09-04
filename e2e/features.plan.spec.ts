import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp, latestTrace } from './support/app-helpers'
import {
  providerMessageText,
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

test.describe('Electron plan workflows', () => {
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

  test('starts a reviewed /plan flow with a resource-backed prompt', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-plan-set',
        name: 'plan_set',
        args: {
          objective: 'Validate the prompt harness e2e flow',
          items: ['Inspect prompt harness state', 'Report verification'],
        },
      }),
    ])
    fakeProvider.queue([textDelta('Plan is ready for review.')])
    fakeProvider.queue([
      toolCallsDelta([
        {
          id: 'call:e2e-plan-item-1',
          name: 'plan_update',
          args: {
            id: 'item:1',
            status: 'completed',
            result: 'Inspected prompt harness state',
            evidence: 'E2E provider completed item 1',
          },
        },
        {
          id: 'call:e2e-plan-item-2',
          name: 'plan_update',
          args: {
            id: 'item:2',
            status: 'completed',
            result: 'Reported verification',
            evidence: 'E2E provider completed item 2',
          },
        },
      ]),
    ])
    fakeProvider.queue([textDelta('Approved plan continued.')])

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
    await composer.fill('/plan Validate the prompt harness e2e flow')
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect
      .poll(() => fakeProvider.requests.length)
      .toBeGreaterThanOrEqual(1)
    const firstRequestText = providerMessageText(fakeProvider.requests[0].body)
    expect(firstRequestText).toContain(
      '<orchestration_request kind="plan-started">',
    )
    expect(firstRequestText).toContain('Validate the prompt harness e2e flow')
    expect(firstRequestText).toContain('plan_set')

    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    const planView = page.locator('.plan-view')
    await expect(planView).toContainText('Validate the prompt harness e2e flow')
    await expect(planView).toContainText('待审查')
    await expect(
      planView.getByRole('button', { name: '批准并开始' }),
    ).toBeVisible()
    await planView.getByRole('button', { name: '批准并开始' }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(4)
    expect(providerMessageText(fakeProvider.requests[2].body)).toContain(
      '用户已批准当前计划。继续执行已激活的计划。',
    )
    await expect(
      page.locator('.chat-message.assistant', {
        hasText: 'Approved plan continued.',
      }),
    ).toBeVisible()
    await expect(planView).toContainText('已结束')

    const trace = await latestTrace({ userDataPath })
    expect(trace.raw).toContain('"type":"plan.status"')
    expect(trace.raw).toContain('"previousStatus":"awaiting_review"')
    expect(trace.raw).toContain('"status":"active"')
  })

  test('rejects a reviewed /plan without starting another provider run', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-plan-reject-set',
        name: 'plan_set',
        args: {
          objective: 'Reject this e2e plan',
          items: ['Inspect rejected plan'],
        },
      }),
    ])
    fakeProvider.queue([textDelta('Rejected plan is ready for review.')])

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
    await composer.fill('/plan Reject this e2e plan')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)

    const planView = page.locator('.plan-view')
    await expect(planView).toContainText('待审查')
    await planView.getByRole('button', { name: '不批准' }).click()
    await expect(planView).toContainText('已拒绝')
    await page.waitForTimeout(250)
    expect(fakeProvider.requests.length).toBe(2)

    const trace = await latestTrace({ userDataPath })
    expect(trace.raw).toContain('"type":"plan.status"')
    expect(trace.raw).toContain('"status":"rejected"')
  })

  test('keeps normal tool approval available after same-batch plan_set', async () => {
    fakeProvider.queue([
      toolCallsDelta([
        {
          id: 'call:e2e-same-batch-plan',
          name: 'plan_set',
          args: {
            items: ['Create a file after review'],
          },
        },
        {
          id: 'call:e2e-same-batch-write',
          name: 'write_file',
          args: {
            path: 'same-batch-plan.txt',
            content: 'same batch approval\n',
            _agent_intent: 'Create the same-batch approval fixture',
          },
        },
      ]),
    ])
    fakeProvider.queue([textDelta('Same-batch write completed.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Create a plan and same-batch file')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(1)

    const planView = page.locator('.plan-view')
    await expect(planView).toContainText('待审查')
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('write_file')
    await expect(approval).toContainText('same-batch-plan.txt')
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    await expect
      .poll(async () =>
        readFile(path.join(workspace, 'same-batch-plan.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('same batch approval\n')
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(
      page.locator('.chat-message.assistant', {
        hasText: 'Same-batch write completed.',
      }),
    ).toBeVisible()
  })
})
