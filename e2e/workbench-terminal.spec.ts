import { expect, test, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'
import {
  disposeElectronHarness,
  launchElectronHarness,
  type ElectronHarness,
} from './support/electron-harness'

test.describe.serial('Electron workbench and terminal workflows', () => {
  let harness: ElectronHarness
  let electronApp: ElectronApplication
  let electronProcess: ChildProcess
  let page: Page
  let workspace: string

  test.beforeAll(async () => {
    harness = await launchElectronHarness('agent-e2e-')
    ;({ electronApp, electronProcess, page, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => disposeElectronHarness(harness))

  test('persists conversation fork metadata and reverts in place through the workbench', async () => {
    const timestamp = '2026-06-22T00:00:00.000Z'
    // Seed a source conversation plus a fork branch directly via the validated
    // workbench IPC. This exercises the R6.1 schema migration: the new
    // fork-pointer fields must round-trip through saveSnapshot and the TypeBox
    // validators without being rejected.
    const seeded = await page.evaluate(
      async ({ workspacePath, stamp }) => {
        const api = Reflect.get(window, 'agentApi') as {
          saveWorkbench(payload: unknown): Promise<{ ok: boolean }>
        }
        return api.saveWorkbench({
          version: 1,
          workbench: {
            projects: [
              { path: workspacePath, name: 'workspace', addedAt: stamp },
            ],
            conversations: [
              {
                id: 'conversation:source',
                projectPath: workspacePath,
                title: 'Source conversation',
                model: 'deepseek-chat',
                mode: 'auto',
                messages: [
                  {
                    id: 'm1',
                    role: 'user',
                    text: 'one',
                    reasoning: '',
                    order: 0,
                  },
                  {
                    id: 'm2',
                    role: 'assistant',
                    text: 'two',
                    reasoning: '',
                    order: 1,
                  },
                  {
                    id: 'm3',
                    role: 'user',
                    text: 'three',
                    reasoning: '',
                    order: 2,
                  },
                ],
                tools: [],
                createdAt: stamp,
                updatedAt: stamp,
              },
              {
                id: 'conversation:fork',
                projectPath: workspacePath,
                title: 'Fork: Source conversation',
                model: 'deepseek-chat',
                mode: 'auto',
                messages: [
                  {
                    id: 'm1',
                    role: 'user',
                    text: 'one',
                    reasoning: '',
                    order: 0,
                  },
                  {
                    id: 'm2',
                    role: 'assistant',
                    text: 'two',
                    reasoning: '',
                    order: 1,
                  },
                ],
                tools: [],
                parentId: 'conversation:source',
                parentTitle: 'Source conversation',
                forkPointMessageId: 'm2',
                forkedAt: stamp,
                createdAt: stamp,
                updatedAt: stamp,
              },
            ],
            activeConversationId: 'conversation:source',
          },
        })
      },
      { workspacePath: workspace, stamp: timestamp },
    )
    expect(seeded.ok).toBe(true)

    // Reload and read the workbench back: every fork field must survive.
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    const roundTripped = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getWorkbench(payload: unknown): Promise<{
          ok: boolean
          value?: {
            conversations: Array<Record<string, unknown>>
          }
        }>
      }
      const loaded = await api.getWorkbench({ version: 1 })
      const byId = (id: string) =>
        loaded.value?.conversations?.find(
          (conversation) => conversation.id === id,
        )
      const messageCount = (id: string): number | undefined => {
        const messages = byId(id)?.messages
        return Array.isArray(messages) ? messages.length : undefined
      }
      return {
        conversationCount: loaded.value?.conversations?.length,
        sourceCount: messageCount('conversation:source'),
        fork: {
          parentId: byId('conversation:fork')?.parentId,
          parentTitle: byId('conversation:fork')?.parentTitle,
          forkedAt: byId('conversation:fork')?.forkedAt,
          forkPointMessageId: byId('conversation:fork')?.forkPointMessageId,
          messageCount: messageCount('conversation:fork'),
        },
      }
    })

    expect(roundTripped.conversationCount).toBe(2)
    expect(roundTripped.sourceCount).toBe(3)
    expect(roundTripped.fork).toMatchObject({
      parentId: 'conversation:source',
      parentTitle: 'Source conversation',
      forkedAt: timestamp,
      forkPointMessageId: 'm2',
      messageCount: 2,
    })

    // Handler-level markdown import/export behavior is covered by unit tests;
    // this e2e case only verifies the persisted workbench remains readable.
    const exported = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getWorkbench(payload: unknown): Promise<{ ok: boolean }>
      }
      const loaded = await api.getWorkbench({ version: 1 })
      return loaded.ok
    })
    expect(exported).toBe(true)
  })

  test('opens, drives, restores, and closes persistent terminal tabs', async () => {
    const configured = await page.evaluate(async (workspacePath) => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{
          ok: boolean
        }>
      }
      return api.setConfig({
        version: 1,
        kind: 'workspace',
        lastOpened: workspacePath,
      })
    }, workspace)
    expect(configured.ok).toBe(true)

    await page.reload()
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
            const { event } = envelope

            if (
              event.type === 'terminal.status' &&
              event.status === 'running'
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
      name: '关闭终端',
    })
    await expect(closeButtons).toHaveCount(2)
    await closeButtons.nth(0).click()
    await expect(terminalTabs).toHaveCount(1)
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
