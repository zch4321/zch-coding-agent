import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp } from './support/app-helpers'
import {
  providerMessageText,
  providerMessages,
  reasoningDelta,
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

async function openAgentsTab(page: Page): Promise<void> {
  const sidebarToggle = page.getByRole('button', {
    name: '切换右侧栏（Ctrl+Shift+B）',
  })
  if ((await sidebarToggle.getAttribute('aria-pressed')) !== 'true') {
    await sidebarToggle.click()
  }
  await page.getByRole('tab', { name: /Agents/u }).click()
  await expect(page.locator('.agent-executions-view')).toBeVisible()
}

async function expandExecution(page: Page, name: string): Promise<Locator> {
  const item = page.locator('.agent-execution-item', { hasText: name })
  await expect(item).toBeVisible()
  if (
    !(await item.getAttribute('class'))?.includes('n-collapse-item--active')
  ) {
    await item.locator('.n-collapse-item__header-main').first().click()
  }
  await expect(item).toHaveClass(/n-collapse-item--active/u)
  return item
}

async function readAgentExecutionDetails(page: Page) {
  return page.evaluate(async () => {
    type IpcResult<Value> =
      | { ok: true; value: Value }
      | { ok: false; error: { message: string } }
    type ExecutionDetail = {
      activityPage: { records: unknown[] }
      task?: string
      live?: {
        status: string
        text: string
        reasoning: string
        tools: unknown[]
      }
    }
    const api = Reflect.get(window, 'agentApi') as {
      getBootstrap(
        payload: unknown,
      ): Promise<IpcResult<{ sessionPage: { records: Array<{ id: string }> } }>>
      listAgentExecutions(
        payload: unknown,
      ): Promise<
        IpcResult<{ page: { records: Array<{ id: string; name: string }> } }>
      >
      getAgentExecution(
        payload: unknown,
      ): Promise<IpcResult<{ detail: ExecutionDetail }>>
    }
    const bootstrap = await api.getBootstrap({ version: 1 })
    if (!bootstrap.ok) throw new Error(bootstrap.error.message)
    const parentSessionId = bootstrap.value.sessionPage.records[0]?.id
    if (!parentSessionId) throw new Error('Expected parent Session')
    const listed = await api.listAgentExecutions({
      version: 1,
      parentSessionId,
    })
    if (!listed.ok) throw new Error(listed.error.message)
    return Promise.all(
      listed.value.page.records.map(async (summary) => {
        const loaded = await api.getAgentExecution({
          version: 1,
          parentSessionId,
          executionId: summary.id,
          limit: 100,
        })
        if (!loaded.ok) throw new Error(loaded.error.message)
        return { name: summary.name, detail: loaded.value.detail }
      }),
    )
  })
}

test.describe('Electron Agents activity panel', () => {
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

  test('shows two concurrent Subagents live and restores their durable activity', async () => {
    await writeFile(
      path.join(workspace, 'long-agent-result.txt'),
      `${'delegated-result-line '.repeat(1_500)}\n`,
      'utf8',
    )
    fakeProvider.armResponseGate([4, 5])
    fakeProvider.queue([
      toolCallsDelta([
        {
          id: 'call:e2e-subagent-first',
          name: 'subagent_run',
          args: {
            name: 'first-reviewer',
            task: 'Review the long fixture and report the important result.',
          },
        },
        {
          id: 'call:e2e-subagent-second',
          name: 'subagent_run',
          args: {
            name: 'second-reviewer',
            task: 'Independently review the long fixture and report it.',
          },
        },
      ]),
    ])
    fakeProvider.queue([
      reasoningDelta('Inspect the delegated fixture first.'),
      toolCallDelta({
        id: 'call:e2e-child-read-first',
        name: 'read_file',
        args: { path: 'long-agent-result.txt' },
      }),
    ])
    fakeProvider.queue([
      reasoningDelta('Verify the delegated fixture independently.'),
      toolCallDelta({
        id: 'call:e2e-child-read-second',
        name: 'read_file',
        args: { path: 'long-agent-result.txt' },
      }),
    ])
    fakeProvider.queue([
      reasoningDelta('Summarize the first completed review.'),
      textDelta('Delegated review completed.'),
    ])
    fakeProvider.queue([
      reasoningDelta('Summarize the second completed review.'),
      textDelta('Delegated review completed.'),
    ])
    fakeProvider.queue([textDelta('Parent collected both reviews.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      subagents: true,
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Run two independent Subagent reviews now.')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(5)

    const liveDetails = await readAgentExecutionDetails(page)
    expect(liveDetails).toHaveLength(2)
    for (const executionDetail of liveDetails) {
      expect(executionDetail.detail.live).toMatchObject({
        status: 'calling_llm',
        tools: [expect.objectContaining({ tool: 'read_file' })],
      })
      expect(executionDetail.detail.live).not.toHaveProperty('sessionId')
      expect(executionDetail.detail.live).not.toHaveProperty('runId')
    }

    await openAgentsTab(page)
    const items = page.locator('.agent-execution-item')
    await expect(items).toHaveCount(2)
    await expect(
      page.locator('.agent-execution-item', { hasText: 'first-reviewer' }),
    ).toHaveCount(1)
    await expect(
      page.locator('.agent-execution-item', { hasText: 'second-reviewer' }),
    ).toHaveCount(1)
    await expect(
      page.locator(
        '.agent-execution-status-dot.status-running, .agent-execution-status-dot.status-preparing',
      ),
    ).toHaveCount(2)
    await expect(
      page.locator('.agent-execution-item.n-collapse-item--active'),
    ).toHaveCount(0)

    for (const name of ['first-reviewer', 'second-reviewer']) {
      const item = await expandExecution(page, name)
      await expect(item.locator('.agent-execution-tool-count')).toContainText(
        '1',
      )
      await expect(item.locator('.tool-call-card')).toHaveCount(0)
      await expect(item).not.toContainText('Inspect the delegated fixture')
      await expect(item).not.toContainText('Verify the delegated fixture')
    }

    fakeProvider.releaseResponseGate()
    await expect.poll(() => fakeProvider.requests.length).toBe(6)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Parent collected both reviews.',
    )
    await expect(
      page.locator('.agent-execution-status-dot.status-completed'),
    ).toHaveCount(2)
    const parentFollowup = providerMessageText(fakeProvider.requests[5]!.body)
    expect(parentFollowup.match(/Delegated review completed\./g)).toHaveLength(
      2,
    )
    expect(
      providerMessages(fakeProvider.requests[5]!.body)
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
    ).toEqual(['call:e2e-subagent-first', 'call:e2e-subagent-second'])
    await expect(page.locator('button.conversation-item')).toHaveCount(1)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const restoredDetail = (await readAgentExecutionDetails(page)).find(
      (record) => record.name === 'first-reviewer',
    )?.detail
    expect(restoredDetail).toBeDefined()
    if (!restoredDetail) throw new Error('Expected restored detail')
    expect(restoredDetail.task).toContain('Review the long fixture')
    expect(JSON.stringify(restoredDetail.activityPage.records)).toContain(
      'read_file',
    )
    await openAgentsTab(page)
    await expect(page.locator('.agent-execution-item')).toHaveCount(2)
    await expect(
      page.locator('.agent-execution-item.n-collapse-item--active'),
    ).toHaveCount(0)
    const restored = await expandExecution(page, 'first-reviewer')
    await expect(restored.locator('.agent-execution-tool-count')).toContainText(
      '1',
    )
    await expect(restored.locator('.tool-call-card')).toHaveCount(0)
    await expect(restored).toContainText('Delegated review completed.')
    await expect(page.locator('button.conversation-item')).toHaveCount(1)
  })

  test('runs a Swarm as one Job with manually expanded child Agents', async () => {
    fakeProvider.armResponseGate([2, 3])
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-swarm',
        name: 'swarm_run',
        args: {
          tasks: [
            {
              name: 'review',
              task: 'Review the repository independently.',
              requiredCapability: 'standard',
              agentCount: 2,
            },
          ],
        },
      }),
    ])
    fakeProvider.queue([textDelta('Replica review completed.')])
    fakeProvider.queue([textDelta('Replica review completed.')])
    fakeProvider.queue([textDelta('Parent synthesized both Swarm reviews.')])

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
      .fill('/swarm Review the repository independently')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(3)

    await openAgentsTab(page)
    await expect(page.locator('.agent-execution-item')).toHaveCount(1)
    await expect(
      page.locator('.agent-execution-item.n-collapse-item--active'),
    ).toHaveCount(0)
    const root = await expandExecution(page, 'Swarm')
    const children = root.locator('.agent-execution-child-item')
    await expect(children).toHaveCount(2)
    await expect(
      root.locator('.agent-execution-child-item.n-collapse-item--active'),
    ).toHaveCount(0)
    await expect(children.nth(0)).toContainText('review · 1/2')
    await expect(children.nth(1)).toContainText('review · 2/2')

    fakeProvider.releaseResponseGate()
    await expect.poll(() => fakeProvider.requests.length).toBe(4)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Parent synthesized both Swarm reviews.',
    )
    await expect(
      root.locator('.agent-execution-status-dot.status-completed'),
    ).toHaveCount(3)

    await children
      .nth(0)
      .locator('.n-collapse-item__header-main')
      .first()
      .click()
    await expect(children.nth(0)).toHaveClass(/n-collapse-item--active/u)
    await expect(children.nth(0)).toContainText('Replica review completed.')
    const parentFollowup = providerMessageText(fakeProvider.requests[3]!.body)
    expect(parentFollowup.match(/Replica review completed\./gu)).toHaveLength(2)
    expect(parentFollowup.indexOf('review · 1/2')).toBeLessThan(
      parentFollowup.indexOf('review · 2/2'),
    )
    await expect(page.locator('button.conversation-item')).toHaveCount(1)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await openAgentsTab(page)
    await expect(page.locator('.agent-execution-item')).toHaveCount(1)
    await expect(
      page.locator('.agent-execution-item.n-collapse-item--active'),
    ).toHaveCount(0)
    const restoredRoot = await expandExecution(page, 'Swarm')
    await expect(
      restoredRoot.locator('.agent-execution-child-item'),
    ).toHaveCount(2)
    await expect(
      restoredRoot.locator(
        '.agent-execution-child-item.n-collapse-item--active',
      ),
    ).toHaveCount(0)
  })
})
