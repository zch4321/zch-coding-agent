import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  disposeElectronHarness,
  launchElectronHarness,
  type ElectronHarness,
} from './support/electron-harness'
import {
  providerApiKey,
  providerModel,
  startFakeProvider,
  type FakeProvider,
} from './support/fake-provider'

test.describe.serial('Electron settings workflows', () => {
  let harness: ElectronHarness
  let page: Page
  let userDataPath: string
  let workspace: string
  let fakeProvider: FakeProvider

  test.beforeAll(async () => {
    fakeProvider = await startFakeProvider()
    harness = await launchElectronHarness('agent-e2e-')
    ;({ page, userDataPath, workspace } = harness)
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterAll(async () => {
    await Promise.all([disposeElectronHarness(harness), fakeProvider.close()])
  })

  test('shows assistant preferences, model discovery, and budget controls', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const settingsSidebar = page.locator('.settings-sidebar')
    const settingsSidebarLayout = await settingsSidebar.evaluate((sidebar) => {
      const sidebarBounds = sidebar.getBoundingClientRect()
      const buttonBounds = (
        sidebar.querySelector('.settings-back-button') as HTMLElement
      ).getBoundingClientRect()
      return {
        clientWidth: sidebar.clientWidth,
        scrollWidth: sidebar.scrollWidth,
        sidebarLeft: sidebarBounds.left,
        sidebarRight: sidebarBounds.right,
        buttonLeft: buttonBounds.left,
        buttonRight: buttonBounds.right,
      }
    })
    expect(settingsSidebarLayout.scrollWidth).toBeLessThanOrEqual(
      settingsSidebarLayout.clientWidth,
    )
    expect(settingsSidebarLayout.buttonLeft).toBeGreaterThanOrEqual(
      settingsSidebarLayout.sidebarLeft,
    )
    expect(settingsSidebarLayout.buttonRight).toBeLessThanOrEqual(
      settingsSidebarLayout.sidebarRight,
    )
    const settingsNavigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await settingsNavigation.getByRole('menuitem', { name: '通用' }).click()
    const general = page.locator('.settings-section')
    await expect(general.getByText('中文助手偏好')).toBeVisible()
    await expect(general.getByText('英文助手偏好')).toBeVisible()
    const zhPrompt = general
      .locator('.settings-field', { hasText: '中文助手偏好' })
      .locator('textarea')
    const saveStatus = general.locator('.settings-save-status')
    await zhPrompt.fill('E2E 中文助手偏好')
    await expect(zhPrompt).toHaveValue('E2E 中文助手偏好')
    await general.getByRole('button', { name: '保存助手偏好' }).click()
    await expect(saveStatus).toHaveText('已保存')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              ok: boolean
              value?: {
                config: {
                  assistant: { preferences: Record<string, string> }
                }
              }
            }>
          }
          const savedPrompt = await api.getConfig({
            version: 1,
            section: 'assistant',
          })
          return savedPrompt.value?.config.assistant.preferences['zh-CN']
        }),
      )
      .toBe('E2E 中文助手偏好')
    await general.getByRole('button', { name: '清空助手偏好' }).click()
    await general.getByRole('button', { name: '保存助手偏好' }).click()
    await expect(saveStatus).toHaveText('已保存')

    await settingsNavigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')

    await expect(provider.locator('.provider-card')).toHaveCount(1)
    await expect(provider.locator('.provider-card')).toContainText('DeepSeek')
    await expect(provider.getByText('主模型', { exact: true })).toBeVisible()
    await expect(
      provider.getByText('上下文窗口覆盖值', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('最大输出覆盖值', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Token 估算方式', { exact: true }),
    ).toBeVisible()
    await expect(
      provider.getByText('Provider Type', { exact: true }),
    ).toBeVisible()
    const providerTypeSelect = provider
      .locator('.settings-field', { hasText: 'Provider Type' })
      .locator('.n-select')
    await providerTypeSelect.click()
    await expect(
      page.getByText('通用 Responses', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('通用 Anthropic Messages', { exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      provider.getByText('自动审批模型', { exact: true }),
    ).toHaveCount(0)
    const refreshModels = provider.getByRole('button', { name: '刷新' })
    await expect(refreshModels).toBeDisabled()
    await provider
      .locator('.settings-field', { hasText: '基础 URL' })
      .locator('input')
      .fill(fakeProvider.origin)
    await provider.getByPlaceholder('输入新的 Key').fill(providerApiKey)
    await expect(refreshModels).toBeEnabled()
    await refreshModels.click()
    await expect(provider.getByText('思考深度', { exact: true })).toBeVisible()
    await expect(provider.locator('.n-input-number')).toHaveCount(3)

    const modelSelect = provider
      .locator('.settings-field', { hasText: '主模型' })
      .locator('.n-select')
    await modelSelect.click()
    await expect(
      page.locator('.n-base-select-option', { hasText: providerModel }),
    ).toBeVisible()
    await page.keyboard.type('custom-e2e-model')
    await page.keyboard.press('Enter')
    await expect(modelSelect).toContainText('custom-e2e-model')
    await page.keyboard.press('Escape')

    await settingsNavigation.getByRole('menuitem', { name: '自动审批' }).click()
    const approval = page.locator('.settings-section')
    await expect(
      approval.getByRole('heading', { name: '自动审批' }),
    ).toBeVisible()
    const approvalModel = approval
      .locator('.settings-field', { hasText: '自动审批模型' })
      .locator('.n-select')
    await approvalModel.click()
    await page.getByText(providerModel, { exact: true }).click()
    await approval.getByRole('button', { name: '保存自动审批' }).click()
    await expect(approval.locator('.settings-save-status')).toHaveText('已保存')
  })

  test('manages provider cards through the settings page', async () => {
    const seeded = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getConfig(payload: unknown): Promise<{
          ok: boolean
          value?: { config: { limits: unknown } }
        }>
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      const current = await api.getConfig({ version: 1, section: 'all' })
      if (!current.ok || !current.value) return false
      const result = await api.setConfig({
        version: 1,
        kind: 'provider-settings',
        providerId: 'e2e-alt',
        label: 'E2E Alt',
        providerType: 'generic.chat-completions',
        baseURL: 'https://provider.example/v1',
        model: 'e2e-alt-chat',
        reasoning: 'off',
        limits: current.value.config.limits,
      })
      return result.ok
    })
    expect(seeded).toBe(true)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')

    await expect(provider.locator('.provider-card')).toHaveCount(2)
    const altCard = provider.locator('.provider-card', { hasText: 'E2E Alt' })
    await expect(altCard).toContainText('e2e-alt-chat')

    await provider.getByRole('button', { name: '新增 Provider' }).click()
    await expect(
      provider.locator('.provider-card', { hasText: 'New Provider' }),
    ).toBeVisible()

    await altCard.click()
    await provider
      .locator('.settings-field', { hasText: 'Provider 名称' })
      .locator('input')
      .fill('E2E Alt Edited')
    await provider.getByRole('button', { name: '保存模型服务' }).click()
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')
    await expect(
      provider.locator('.provider-card', { hasText: 'E2E Alt Edited' }),
    ).toBeVisible()

    await provider.getByRole('button', { name: '设为默认' }).click()
    await expect(
      provider.locator('.provider-card.active', { hasText: 'E2E Alt Edited' }),
    ).toContainText('默认')

    const editedCard = provider.locator('.provider-card', {
      hasText: 'E2E Alt Edited',
    })
    await editedCard.getByRole('button', { name: '操作' }).click()
    await page.getByText('复制 Provider', { exact: true }).click()
    const copyCard = provider.locator('.provider-card', {
      hasText: 'E2E Alt Edited Copy',
    })
    await expect(copyCard).toBeVisible()

    await copyCard.getByRole('button', { name: '操作' }).click()
    await page.getByText('删除 Provider', { exact: true }).last().click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '删除 Provider' })
      .click()
    await expect(copyCard).toHaveCount(0)

    const configSnapshot = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getConfig(payload: unknown): Promise<{
          value?: {
            config: {
              approval: {
                approverProviderId: string
                approverModel: string
              }
            }
          }
        }>
      }
      const result = await api.getConfig({ version: 1, section: 'all' })
      return {
        text: JSON.stringify(result),
        approval: result.value?.config.approval,
      }
    })
    expect(configSnapshot.text).not.toContain('apiKeyRef')
    expect(configSnapshot.approval).toEqual({
      approverProviderId: 'deepseek',
      approverModel: providerModel,
    })
  })

  test('exposes skill management and bounded trace diagnostics in settings', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await navigation.getByRole('menuitem', { name: '技能' }).click()
    const skills = page.locator('.settings-section')
    await expect(skills.getByText('未找到有效技能。')).toBeVisible()
    await expect(
      skills.getByPlaceholder('https://example.com/skill.md'),
    ).toBeVisible()
    await expect(skills.getByRole('button', { name: '安装文件' })).toBeVisible()
    await expect(skills.getByRole('button', { name: '刷新' })).toBeVisible()
    await writeFile(
      path.join(userDataPath, 'skills', 'e2e-skill.md'),
      '---\nname: e2e-skill\ndescription: E2E skill without optional trigger\n---\nUse E2E instructions.\n',
    )
    await skills.getByRole('button', { name: '刷新' }).click()
    await expect(skills.getByText('e2e-skill', { exact: true })).toBeVisible()
    await expect(
      skills.getByText('E2E skill without optional trigger'),
    ).toBeVisible()

    await navigation.getByRole('menuitem', { name: 'MCP 连接' }).click()
    const mcp = page.locator('.settings-section')
    await expect(mcp.getByRole('heading', { name: 'MCP 连接' })).toBeVisible()
    await expect(mcp.getByText('配置中没有 MCP server。')).toBeVisible()
    await expect(
      mcp.getByRole('button', { name: '重新加载配置' }),
    ).toBeVisible()

    const traceDirectory = path.join(userDataPath, 'traces')
    await mkdir(traceDirectory, { recursive: true })
    const traceId = 'prompt-inspector-e2e'
    const traceLines = [
      {
        schemaVersion: 2,
        seq: 1,
        eventId: 'event-prompt-e2e-1',
        ts: '2026-06-25T00:00:00.000Z',
        type: 'session.start',
        sessionId: 'session-prompt-e2e',
        workspace,
        model: 'deepseek-chat',
        mode: 'readonly',
      },
      {
        schemaVersion: 2,
        seq: 2,
        eventId: 'event-prompt-e2e-2',
        ts: '2026-06-25T00:00:01.000Z',
        type: 'run.start',
        sessionId: 'session-prompt-e2e',
        runId: 'run-prompt-e2e',
      },
      {
        schemaVersion: 2,
        seq: 3,
        eventId: 'event-prompt-e2e-3',
        ts: '2026-06-25T00:00:02.000Z',
        type: 'llm.request',
        sessionId: 'session-prompt-e2e',
        runId: 'run-prompt-e2e',
        callId: 'llm-prompt-e2e',
        normalizedMessages: [
          { role: 'system', content: 'base harness' },
          { role: 'system', content: 'runtime harness' },
          {
            role: 'user',
            content:
              '<assistant_preferences status="configured">E2E preference</assistant_preferences>',
          },
          { role: 'user', content: '<agents>Use E2E AGENTS.</agents>' },
          { role: 'user', content: 'raw user request' },
        ],
        providerRequest: { messages: [] },
        requestBytes: 128,
        prefixHash: 'a'.repeat(64),
        canonicalSource: [
          {
            seq: 1,
            kind: 'system_instruction',
            partTypes: ['text'],
            hash: '1'.repeat(64),
          },
          {
            seq: 2,
            kind: 'runtime_context',
            partTypes: ['text'],
            hash: '2'.repeat(64),
          },
          {
            seq: 3,
            kind: 'assistant_preferences',
            partTypes: ['text'],
            hash: '3'.repeat(64),
          },
          {
            seq: 4,
            kind: 'agents_context',
            partTypes: ['text'],
            hash: '4'.repeat(64),
          },
          {
            seq: 5,
            kind: 'user_input',
            partTypes: ['text'],
            hash: '5'.repeat(64),
          },
        ],
        modelRoute: {
          schemaVersion: 2,
          purpose: 'main',
          providerType: 'deepseek.chat-completions',
          providerId: 'deepseek',
          model: 'deepseek-chat',
          reasoning: 'off',
          endpoint: 'https://api.deepseek.com/chat/completions',
          providerConfigRevision: 1,
        },
        promptBuild: {
          schemaVersion: 2,
          messageCount: 5,
          activeMessageCount: 5,
          omittedHistoryMessages: 0,
          promptBudgetTokens: 64000,
          estimatedTokens: 128,
          toolsHash: 'b'.repeat(64),
          sourceHash: '9'.repeat(64),
          layers: [
            {
              seq: 1,
              messageId: 'message-prompt-e2e-1',
              kind: 'system_instruction',
              source: 'resources/prompts/harness/base-instructions.zh-CN.md',
              trusted: true,
              editable: false,
              sha256: 'c'.repeat(64),
              estimatedTokens: 10,
              included: true,
              truncated: false,
            },
            {
              seq: 2,
              messageId: 'message-prompt-e2e-2',
              kind: 'runtime_context',
              source: 'resources/prompts/harness/runtime-context.zh-CN.md',
              trusted: true,
              editable: false,
              sha256: 'd'.repeat(64),
              estimatedTokens: 10,
              included: true,
              truncated: false,
            },
            {
              seq: 3,
              messageId: 'message-prompt-e2e-3',
              kind: 'assistant_preferences',
              source: 'config.assistant.preferences',
              trusted: false,
              editable: true,
              sha256: 'e'.repeat(64),
              estimatedTokens: 10,
              included: true,
              truncated: false,
            },
            {
              seq: 4,
              messageId: 'message-prompt-e2e-4',
              kind: 'agents_context',
              source: 'workspace:AGENTS',
              trusted: false,
              editable: false,
              sha256: 'f'.repeat(64),
              estimatedTokens: 10,
              included: true,
              truncated: false,
            },
          ],
        },
      },
      {
        schemaVersion: 2,
        seq: 4,
        eventId: 'event-prompt-e2e-4',
        ts: '2026-06-25T00:00:03.000Z',
        type: 'run.end',
        sessionId: 'session-prompt-e2e',
        runId: 'run-prompt-e2e',
        status: 'completed',
      },
      {
        schemaVersion: 2,
        seq: 5,
        eventId: 'event-prompt-e2e-5',
        ts: '2026-06-25T00:00:04.000Z',
        type: 'session.end',
        sessionId: 'session-prompt-e2e',
      },
    ]
    await writeFile(
      path.join(traceDirectory, `${traceId}.jsonl`),
      traceLines.map((line) => JSON.stringify(line)).join('\n'),
      'utf8',
    )

    await navigation.getByRole('menuitem', { name: '日志' }).click()
    const logging = page.locator('.settings-section')
    await expect(
      logging.getByRole('button', { name: '打开日志目录' }),
    ).toBeVisible()
    await expect(
      logging.getByRole('button', { name: '清理已关闭 Trace' }),
    ).toBeVisible()
    await expect(
      logging.getByRole('heading', { name: '离线回放', exact: true }),
    ).toBeVisible()
    await expect(logging.getByText('请求数', { exact: true })).toBeVisible()
    await logging.getByRole('button', { name: '刷新 Trace' }).click()
    await logging.locator('.trace-debug').locator('.n-select').first().click()
    await page.getByText(traceId).click()
    await logging.getByRole('button', { name: '离线回放' }).click()
    await expect(logging.getByText('Prompt Inspector')).toBeVisible()
    await expect(logging.getByText('system_instruction')).toBeVisible()
    await expect(logging.getByText('runtime_context')).toBeVisible()
    await expect(logging.getByText('assistant_preferences')).toBeVisible()
    await expect(logging.getByText('agents_context')).toBeVisible()
    await logging.getByText('#2 · user').click()
    await expect(logging.getByText('E2E preference')).toBeVisible()
  })
})
