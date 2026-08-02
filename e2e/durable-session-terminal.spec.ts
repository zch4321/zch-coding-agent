import { expect, test, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'
import { configureApp } from './support/app-helpers'
import {
  reasoningDelta,
  textDelta,
  toolCallDelta,
  type FakeProvider,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

test.describe.serial('Durable Session and terminal workflows', () => {
  let harness: FeatureHarness
  let fakeProvider: FakeProvider
  let electronApp: ElectronApplication
  let electronProcess: ChildProcess
  let page: Page
  let workspace: string

  test.beforeAll(async () => {
    harness = await launchFeatureHarness()
    ;({ fakeProvider, electronApp, electronProcess, page, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => disposeFeatureHarness(harness))

  test('retries and edits only user messages without duplicating the user turn', async () => {
    fakeProvider.queue([textDelta('First durable answer')])
    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Original durable request')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'First durable answer',
    )

    const userMessage = page.locator('.chat-message.user').filter({
      hasText: 'Original durable request',
    })
    const assistantMessage = page.locator('.chat-message.assistant').filter({
      hasText: 'First durable answer',
    })
    await expect(
      userMessage.getByRole('button', { name: '重试' }),
    ).toBeVisible()
    await expect(
      userMessage.getByRole('button', { name: '编辑' }),
    ).toBeVisible()
    await expect(
      assistantMessage.getByRole('button', { name: '重试' }),
    ).toHaveCount(0)
    await expect(
      assistantMessage.getByRole('button', { name: '编辑' }),
    ).toHaveCount(0)

    fakeProvider.queue([textDelta('Retried durable answer')])
    await userMessage.getByRole('button', { name: '重试' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '重试' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Retried durable answer',
    )

    const retryState = await page.evaluate(async () => {
      type Message = { kind: string; visibility: string }
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      const api = Reflect.get(window, 'agentApi') as {
        searchSessions(
          payload: unknown,
        ): Promise<IpcResult<{ hits: Array<{ session: { id: string } }> }>>
        listMessages(
          payload: unknown,
        ): Promise<IpcResult<{ page: { records: Message[] } }>>
      }
      const search = await api.searchSessions({
        version: 1,
        text: 'Original durable request',
      })
      if (!search.ok || !search.value.hits[0]) {
        throw new Error('Durable Session not found')
      }
      const sessionId = search.value.hits[0].session.id
      const listed = await api.listMessages({
        version: 1,
        sessionId,
        limit: 200,
      })
      if (!listed.ok) throw new Error(listed.error.message)
      return {
        sessionId,
        userCount: listed.value.page.records.filter(
          (record) => record.kind === 'user_input',
        ).length,
        visibleUsers: listed.value.page.records.filter(
          (record) =>
            record.kind === 'user_input' && record.visibility === 'visible',
        ).length,
        visibleAssistants: listed.value.page.records.filter(
          (record) =>
            record.kind === 'assistant_turn' && record.visibility === 'visible',
        ).length,
      }
    })
    expect(retryState).toMatchObject({
      userCount: 1,
      visibleUsers: 1,
      visibleAssistants: 1,
    })

    const requestsBeforeEdit = fakeProvider.requests.length
    await userMessage.getByRole('button', { name: '编辑' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '编辑' }).click()
    await expect(composer).toHaveValue('Original durable request')
    expect(fakeProvider.requests).toHaveLength(requestsBeforeEdit)
    await expect(page.locator('.chat-message.user')).toHaveCount(0)

    fakeProvider.queue([textDelta('Edited durable answer')])
    await composer.fill('Edited durable request')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Edited durable answer',
    )
    await expect(page.locator('.chat-message.user')).toContainText(
      'Edited durable request',
    )

    const editedUser = page.locator('.chat-message.user').filter({
      hasText: 'Edited durable request',
    })
    await editedUser.getByRole('button', { name: '分支' }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '创建分支' })
      .click()
    await expect(page.locator('.conversation-item')).toHaveCount(2)

    const sessionRow = page.locator('.conversation-row').first()
    await sessionRow.hover()
    const sessionActions = sessionRow.locator('.conversation-actions button')
    await expect(sessionActions).toHaveCount(2)
    const sessionRowLayout = await sessionRow.evaluate((row) => {
      const rowBounds = row.getBoundingClientRect()
      const titleBounds = (
        row.querySelector('.conversation-item') as HTMLElement
      ).getBoundingClientRect()
      const actionBounds = [
        ...row.querySelectorAll<HTMLElement>('.conversation-actions button'),
      ].map((button) => button.getBoundingClientRect())
      return {
        rowLeft: rowBounds.left,
        rowRight: rowBounds.right,
        titleRight: titleBounds.right,
        actionsLeft: actionBounds[0]?.left ?? rowBounds.right,
        actionBounds: actionBounds.map((bounds) => ({
          left: bounds.left,
          right: bounds.right,
        })),
      }
    })
    expect(sessionRowLayout.titleRight).toBeLessThanOrEqual(
      sessionRowLayout.actionsLeft,
    )
    for (const bounds of sessionRowLayout.actionBounds) {
      expect(bounds.left).toBeGreaterThanOrEqual(sessionRowLayout.rowLeft)
      expect(bounds.right).toBeLessThanOrEqual(sessionRowLayout.rowRight)
    }
  })

  test('wraps reasoning inside its independent collapsed timeline group', async () => {
    const longReasoning = `First reasoning line\n${'unbroken-reasoning-'.repeat(160)}`
    fakeProvider.queue([
      reasoningDelta(longReasoning),
      textDelta('Reasoning layout fixture'),
    ])
    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Show the reasoning layout')
    await page.getByRole('button', { name: '发送消息' }).click()

    const assistant = page.locator('.chat-message.assistant').filter({
      hasText: 'Reasoning layout fixture',
    })
    await expect(assistant).toBeVisible()
    const turn = page.locator('.conversation-turn').filter({ has: assistant })
    const reasoningGroup = turn.locator('.reasoning-group')
    await expect(reasoningGroup).toBeVisible()
    await expect(reasoningGroup).toContainText('思考过程')
    await expect(reasoningGroup.locator('.reasoning-content')).toHaveCount(0)
    await reasoningGroup.locator('.n-collapse-item__header-main').click()

    const reasoningContent = reasoningGroup.locator('.reasoning-content')
    await expect(reasoningContent).toBeVisible()
    const layout = await reasoningContent.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }
    })
    expect(layout.whiteSpace).toBe('pre-wrap')
    expect(layout.overflowWrap).toBe('anywhere')
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
  })

  test('opens, drives, restores, and closes terminal tabs for a Session', async () => {
    const terminalReady = page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = Reflect.get(window, 'agentApi') as {
            onTerminalEvent(
              listener: (envelope: {
                event: {
                  type: string
                  status?: string
                }
              }) => void,
            ): () => void
          }
          const unsubscribe = api.onTerminalEvent((envelope) => {
            if (
              envelope.event.type === 'terminal.status' &&
              envelope.event.status === 'running'
            ) {
              unsubscribe()
              resolve()
            }
          })
        }),
    )
    const toggle = page.getByRole('button', { name: /切换终端/ })
    await expect(toggle).toBeEnabled()
    await toggle.click()
    const terminalPanel = page.locator('.terminal-panel')
    const terminalTabs = terminalPanel.getByRole('tab')
    await expect(terminalPanel).toBeVisible()
    await expect(terminalTabs).toHaveCount(1)

    await terminalReady
    const activeInput = page.locator(
      '.terminal-surface:visible .xterm-helper-textarea',
    )
    await expect(activeInput).toBeAttached()
    const terminalBounds = await terminalPanel.evaluate((panel) => {
      const body = panel.querySelector('.terminal-body')
      const surface = panel.querySelector('.terminal-surface')
      const screen = panel.querySelector('.xterm-screen')
      if (!body || !surface || !screen) {
        throw new Error('Expected mounted terminal layout')
      }
      const panelRect = panel.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const surfaceRect = surface.getBoundingClientRect()
      const screenRect = screen.getBoundingClientRect()
      return {
        panelBottom: panelRect.bottom,
        bodyBottom: bodyRect.bottom,
        surfaceBottom: surfaceRect.bottom,
        screenBottom: screenRect.bottom,
      }
    })
    expect(terminalBounds.bodyBottom).toBeLessThanOrEqual(
      terminalBounds.panelBottom + 1,
    )
    expect(terminalBounds.surfaceBottom).toBeLessThanOrEqual(
      terminalBounds.bodyBottom + 1,
    )
    expect(terminalBounds.screenBottom).toBeLessThanOrEqual(
      terminalBounds.surfaceBottom + 1,
    )
    await activeInput.focus()
    await expect
      .poll(() =>
        activeInput.evaluate((element) => document.activeElement === element),
      )
      .toBe(true)
    await page.keyboard.type('Write-Output E2E_PTY_OK', { delay: 2 })
    await page.keyboard.press('Enter')
    await expect(
      page.locator('.terminal-surface:visible .xterm-rows'),
    ).toContainText('E2E_PTY_OK', { timeout: 15_000 })

    await terminalPanel.getByRole('button', { name: '新建终端' }).click()
    await expect(terminalTabs).toHaveCount(2)

    await page.keyboard.press('Control+J')
    await expect(terminalPanel).toBeHidden()
    await page.keyboard.press('Control+J')
    await expect(terminalPanel).toBeVisible()
    await expect(terminalTabs).toHaveCount(2)

    const closeButtons = terminalPanel.getByRole('button', {
      name: 'close',
    })
    await expect(closeButtons).toHaveCount(2)
    await closeButtons.nth(0).click()
    await expect(terminalTabs).toHaveCount(1)
  })

  test('executes a delayed Windows terminal_send command terminated by a bare LF', async () => {
    test.skip(process.platform !== 'win32', 'Windows PTY behavior')
    const target = await page.evaluate(async () => {
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      type Snapshot = { session: { id: string; revision: number } }
      const api = Reflect.get(window, 'agentApi') as {
        searchSessions(
          payload: unknown,
        ): Promise<IpcResult<{ hits: Array<{ session: { id: string } }> }>>
        getSession(payload: unknown): Promise<IpcResult<{ snapshot: Snapshot }>>
        updateSession(payload: unknown): Promise<IpcResult<unknown>>
        openTerminal(
          payload: unknown,
        ): Promise<
          IpcResult<{ terminal: { terminalId: string; status: string } }>
        >
        closeTerminal(
          payload: unknown,
        ): Promise<IpcResult<{ accepted: boolean }>>
        listTerminals(payload: unknown): Promise<
          IpcResult<{
            terminals: Array<{ terminalId: string; status: string }>
          }>
        >
      }
      const search = await api.searchSessions({
        version: 1,
        text: 'Edited durable request',
        limit: 10,
      })
      if (!search.ok || !search.value.hits[0]) {
        throw new Error('Expected the durable Session')
      }
      const sessionId = search.value.hits[0].session.id
      const loaded = await api.getSession({ version: 1, sessionId })
      if (!loaded.ok) throw new Error(loaded.error.message)
      const existing = await api.listTerminals({ version: 1, sessionId })
      if (!existing.ok) throw new Error(existing.error.message)
      for (const terminal of existing.value.terminals) {
        const closed = await api.closeTerminal({
          version: 1,
          sessionId,
          terminalId: terminal.terminalId,
        })
        if (!closed.ok) throw new Error(closed.error.message)
      }
      const updated = await api.updateSession({
        version: 1,
        sessionId,
        expectedRevision: loaded.value.snapshot.session.revision,
        patch: { permissionMode: 'confirm' },
      })
      if (!updated.ok) throw new Error(updated.error.message)
      const opened = await api.openTerminal({ version: 1, sessionId })
      if (!opened.ok) throw new Error(opened.error.message)
      return { sessionId, terminalId: opened.value.terminal.terminalId }
    })

    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-terminal-lf',
        name: 'terminal_send',
        args: {
          terminalId: target.terminalId,
          data: 'Write-Output E2E_TERMINAL_SEND_LF_OK\n',
          delayMs: 100,
        },
      }),
    ])
    fakeProvider.queue([textDelta('Terminal command sent.')])

    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Send the prepared command to the terminal')
    await page.getByRole('button', { name: '发送消息' }).click()
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    await expect
      .poll(() =>
        page.evaluate(async ({ sessionId, terminalId }) => {
          type IpcResult<Value> =
            | { ok: true; value: Value }
            | { ok: false; error: { message: string } }
          const api = Reflect.get(window, 'agentApi') as {
            getTerminalSnapshot(
              payload: unknown,
            ): Promise<IpcResult<{ data: string }>>
          }
          const result = await api.getTerminalSnapshot({
            version: 1,
            sessionId,
            terminalId,
          })
          return result.ok ? result.value.data : ''
        }, target),
      )
      .toContain('E2E_TERMINAL_SEND_LF_OK')
  })

  test('closes cleanly with exit code zero', async () => {
    const exit = new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      electronProcess.once('exit', (code, signal) => resolve({ code, signal }))
    })

    await electronApp.evaluate(({ app }) => {
      app.quit()
    })

    await expect(exit).resolves.toEqual({ code: 0, signal: null })
  })
})
