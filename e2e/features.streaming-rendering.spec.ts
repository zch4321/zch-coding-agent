import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp, findDurableMessageText } from './support/app-helpers'
import {
  reasoningDelta,
  textDelta,
  toolCallDelta,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
} from './support/feature-harness'

test('renders open code plainly, highlights finished code in a worker and preserves its DOM during later text', async ({
  browserName,
}, testInfo) => {
  void browserName
  const harness = await launchFeatureHarness()
  try {
    const { page, fakeProvider, workspace } = harness
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      traceLogging: false,
    })
    const code = Array.from(
      { length: 12 },
      (_, index) => `const value${index}: number = ${index}`,
    ).join('\n')
    const chunks = [
      `# Streaming result\n\n\`\`\`ts\n${code}`,
      '\n```\n\nFirst explanation.',
      '\n\nSecond explanation.',
      '\n\nFinished.',
    ]
    fakeProvider.queue(
      chunks.map((chunk) => textDelta(chunk)),
      { chunkDelayMs: 2000 },
    )
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Show streaming code')
    await page.getByRole('button', { name: '发送消息' }).click()
    const message = page.locator('.chat-message.assistant').last()
    const pre = message.locator('pre')
    await expect(pre).toContainText('value11')
    expect(await pre.innerText()).toContain(code)
    await expect(pre.locator('span[style]')).toHaveCount(0)
    await expect(message).toContainText('First explanation.')
    await expect(pre.locator('span[style]').first()).toBeVisible()
    const preserved = await pre.elementHandle()
    await expect(message).toContainText('Second explanation.')
    expect(
      await pre.evaluate((element, old) => element === old, preserved),
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('streaming-markdown.png'),
    })
    await expect
      .poll(() =>
        findDurableMessageText(page, 'Show streaming code', 'assistant_turn'),
      )
      .toBe(chunks.join(''))
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await expect(
      page.locator('.chat-message.assistant pre span[style]').first(),
    ).toBeVisible()
  } finally {
    await disposeFeatureHarness(harness)
  }
})

test('follows live reasoning and respects upward scrolling while tools and CoT continue without a reply', async ({
  browserName,
}, testInfo) => {
  void browserName
  const harness = await launchFeatureHarness()
  try {
    const { page, fakeProvider, workspace } = harness
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
      reasoningEffort: 'high',
      traceLogging: false,
    })
    await writeFile(
      path.join(workspace, 'notes.txt'),
      'Tool result line\n'.repeat(80),
    )
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:rendering',
        name: 'read_file',
        args: { path: 'notes.txt', _agent_intent: 'Inspect notes' },
      }),
    ])
    fakeProvider.queue(
      [
        reasoningDelta('Initial thought line\n'.repeat(50)),
        ...Array.from({ length: 200 }, (_, index) =>
          reasoningDelta(`Continuing thought ${index}\n`),
        ),
        textDelta('Finished reasoning.'),
      ],
      { chunkDelayMs: 50 },
    )
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Inspect notes and think through them')
    await page.getByRole('button', { name: '发送消息' }).click()
    const reasoning = page.locator('.reasoning-group').last()
    await expect(reasoning.locator('.run-activity')).toHaveAttribute(
      'data-run-activity',
      'reasoning',
    )
    await reasoning.locator('.n-collapse-item__header-main').first().click()
    const scroll = reasoning.locator(
      '.reasoning-segment-scroll .n-scrollbar-container',
    )
    await expect(scroll).toBeVisible()
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4)
    const group = page.locator('.tool-call-group').last()
    await group.locator('.n-collapse-item__header-main').first().click()
    await group.locator('.tool-call-card .n-collapse-item__header-main').click()
    const result = group.locator('.tool-result-json')
    await expect(result).toContainText('Tool result line')
    const resultNode = await result.elementHandle()
    await scroll.hover()
    await page.mouse.wheel(0, -160)
    await expect(page.locator('.back-to-bottom')).toBeVisible()
    const top = await scroll.evaluate((element) => element.scrollTop)
    const previousLength = (
      await reasoning.locator('.reasoning-content').innerText()
    ).length
    await expect
      .poll(
        async () =>
          (await reasoning.locator('.reasoning-content').innerText()).length,
      )
      .toBeGreaterThan(previousLength + 100)
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(
      top,
      0,
    )
    expect(
      await result.evaluate((element, old) => element === old, resultNode),
    ).toBe(true)
    await expect(page.locator('.chat-message.assistant')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('cot-tool-scroll.png') })
    await page.locator('.back-to-bottom').click()
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Finished reasoning.',
    )
  } finally {
    await disposeFeatureHarness(harness)
  }
})
