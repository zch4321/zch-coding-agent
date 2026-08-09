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
    expect(settingsSidebarLayout.clientWidth).toBe(320)
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

    await settingsNavigation.getByRole('menuitem', { name: '运行限制' }).click()
    const limits = page.locator('.limits-settings-section')
    const saveLimits = limits
      .locator('.settings-heading')
      .getByRole('button', { name: '保存运行限制' })
    await expect(saveLimits).toBeVisible()
    await expect(saveLimits).toBeDisabled()
    await expect(limits.locator('.limits-group')).toHaveCount(6)
    await expect(limits.locator('.n-divider')).toHaveCount(5)
    const limitColumnCount = await limits
      .locator('.limits-grid')
      .evaluate(
        (grid) =>
          getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
            .length,
      )
    expect(limitColumnCount).toBe(1)
    const defaultContext = limits
      .locator('.settings-field', { hasText: '默认最大上下文 Token' })
      .locator('input')
    await expect(defaultContext).toHaveValue('256000')
    const compactPercent = limits.locator('.settings-field', {
      hasText: '自动压缩触发阈值（%）',
    })
    await expect(compactPercent.locator('.n-input-number-suffix')).toHaveText(
      '%',
    )
    const commandShell = limits.locator('.settings-field', {
      hasText: '一次性命令 Shell',
    })
    await expect(commandShell.getByText('实际使用：')).toBeVisible()
    await commandShell.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .filter({ hasText: /^Command Prompt$/u })
      .click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  executionEnvironment: { commandShell: string }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'executionEnvironment',
          })
          return result.value?.config.executionEnvironment.commandShell
        }),
      )
      .toBe('cmd')
    await defaultContext.fill('300000')
    await expect(limits.locator('.settings-save-status')).toHaveText('已保存')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: { config: { limits: { maxContextTokens: number } } }
            }>
          }
          const result = await api.getConfig({ version: 1, section: 'limits' })
          return result.value?.config.limits.maxContextTokens
        }),
      )
      .toBe(300_000)

    await settingsNavigation.getByRole('menuitem', { name: 'Agents' }).click()
    const agents = page.locator('.settings-section')
    await expect(agents.getByRole('heading', { name: 'Agents' })).toBeVisible()
    await expect(
      agents.getByText('子 Agent 会发起额外的模型请求', { exact: false }),
    ).toBeVisible()
    await expect(agents.getByText('当前为 16', { exact: false })).toBeVisible()
    const subagentsSwitch = agents.locator('.n-switch')
    const timeoutMinutes = agents
      .locator('.settings-field', { hasText: '单个子任务超时' })
      .locator('input')
    const maxAgentsPerSwarm = agents
      .locator('.settings-field', { hasText: '单次 Swarm 最大 Agent 数' })
      .locator('input')
    const subagentSaveStatus = agents.locator(
      '.settings-heading-actions .settings-save-status',
    )
    await expect(subagentsSwitch).not.toHaveClass(/n-switch--active/u)
    await expect(timeoutMinutes).toHaveValue('30')
    await expect(maxAgentsPerSwarm).toHaveValue('10')
    await subagentsSwitch.click()
    await timeoutMinutes.fill('45')
    await maxAgentsPerSwarm.fill('12')
    await expect(subagentSaveStatus).toHaveText('已保存')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  subagents: {
                    enabled: boolean
                    workerTimeoutMs: number
                    maxAgentsPerSwarm: number
                  }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'subagents',
          })
          return result.value?.config.subagents
        }),
      )
      .toEqual({
        enabled: true,
        workerTimeoutMs: 2_700_000,
        maxAgentsPerSwarm: 12,
      })
    await subagentsSwitch.click()
    await expect(subagentSaveStatus).toHaveText('已保存')

    await settingsNavigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')

    // Widen the window so the desktop six-column model grid (with header)
    // applies; narrow widths intentionally switch to the stacked layout.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900)
    })

    await expect(provider.locator('.provider-card')).toHaveCount(1)
    await expect(provider.locator('.provider-card')).toContainText('DeepSeek')
    await expect(
      provider.locator('.settings-field > span', { hasText: /^主模型$/ }),
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
    const manualModel = 'manually-added-e2e-model'
    await provider.getByRole('button', { name: '新增模型' }).click()
    const addModelDialog = page
      .getByRole('dialog')
      .filter({ hasText: '新增模型' })
    await addModelDialog
      .getByPlaceholder('输入 Provider 使用的准确模型名称')
      .fill(manualModel)
    const manualContext = addModelDialog
      .locator('.settings-field', { hasText: '最大上下文' })
      .locator('input')
    const manualThreshold = addModelDialog
      .locator('.settings-field', { hasText: '压缩阈值' })
      .locator('input')
    const manualOutput = addModelDialog
      .locator('.settings-field', { hasText: '最大输出长度' })
      .locator('input')
    await manualContext.fill('400000')
    await manualOutput.fill('50000')
    await manualThreshold.fill('250000')
    await addModelDialog
      .locator('.settings-field', { hasText: '思考档位' })
      .locator('.n-select')
      .click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('高', { exact: true })
      .click()
    await page.keyboard.press('Escape')
    await addModelDialog
      .locator('.settings-field', { hasText: '能力等级' })
      .locator('.n-select')
      .click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('强力', { exact: true })
      .click()
    await addModelDialog.getByRole('button', { name: '新增模型' }).click()
    await expect(addModelDialog).toBeHidden()
    const manualModelRow = provider.locator('.provider-model-settings-row', {
      hasText: manualModel,
    })
    await expect(manualModelRow).toBeVisible()
    await expect(
      manualModelRow.getByText('主模型', { exact: true }),
    ).toBeVisible()
    const manualModelDelete = manualModelRow.getByRole('button', {
      name: '删除',
    })
    await expect(manualModelDelete).toBeDisabled()
    await expect(manualModelRow.locator('input').nth(0)).toHaveValue('400000')
    await expect(manualModelRow.locator('input').nth(1)).toHaveValue('250000')
    await expect(manualModelRow.locator('input').nth(2)).toHaveValue('50000')
    await expect(manualModelRow.locator('.n-select').nth(0)).toContainText('高')
    await expect(manualModelRow.locator('.n-select').nth(1)).toContainText(
      '强力',
    )
    await expect
      .poll(async () =>
        page.evaluate(async (modelId) => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  providers: Array<{
                    modelOverrides: Record<string, unknown>
                  }>
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          return result.value?.config.providers[0]?.modelOverrides[modelId]
        }, manualModel),
      )
      .toEqual({
        contextWindowTokens: 400_000,
        compactThresholdTokens: 250_000,
        maxOutputTokens: 50_000,
        reasoningEfforts: ['high'],
        capability: 'strong',
      })
    const refreshModels = provider.getByRole('button', { name: '刷新' })
    await expect(
      provider.getByRole('button', { name: '保存 Provider' }),
    ).toHaveCount(0)
    await expect(refreshModels).toBeDisabled()
    await provider
      .locator('.settings-field', { hasText: '基础 URL' })
      .locator('input')
      .fill(fakeProvider.origin)
    await provider.getByPlaceholder('输入新的 Key').fill(providerApiKey)
    await expect(
      provider.getByText('填写 API Key 后会自动保存并刷新模型目录。'),
    ).toBeVisible()
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')
    await expect.poll(() => fakeProvider.modelCatalogRequests).toBe(1)
    await expect(refreshModels).toBeEnabled()
    await expect(provider.getByText('思考深度', { exact: true })).toBeVisible()
    const modelTransfer = provider.getByTestId('provider-model-transfer')
    await expect(
      modelTransfer.getByText('Provider 模型', { exact: true }),
    ).toBeVisible()
    await expect(
      modelTransfer.getByText('已启用模型', { exact: true }),
    ).toBeVisible()
    const sourceModelFilter = modelTransfer
      .locator('.n-transfer-list--source')
      .getByPlaceholder('筛选模型')
    await sourceModelFilter.fill('model-that-does-not-exist')
    await expect(
      modelTransfer.locator('.n-transfer-list--source .n-empty'),
    ).toBeVisible()
    await sourceModelFilter.fill(providerModel)
    await modelTransfer
      .locator('.n-transfer-list-item--source', { hasText: providerModel })
      .click()
    const discoveredModelRow = provider.locator(
      '.provider-model-settings-row',
      {
        hasText: providerModel,
      },
    )
    await expect(discoveredModelRow).toBeVisible()
    await expect(
      provider.getByText('最大上下文', { exact: true }).first(),
    ).toBeVisible()
    await expect(
      provider.getByText('压缩阈值', { exact: true }).first(),
    ).toBeVisible()
    await expect(
      provider.getByText('最大输出长度', { exact: true }).first(),
    ).toBeVisible()
    await expect(discoveredModelRow.locator('.n-input-number')).toHaveCount(3)
    await expect(discoveredModelRow.locator('input').first()).toHaveValue(
      '300000',
    )
    await expect(discoveredModelRow.locator('input').last()).toHaveValue(
      '65536',
    )
    for (const input of await discoveredModelRow.locator('input').all()) {
      await expect(input).not.toHaveValue('')
    }
    await expect
      .poll(async () =>
        page.evaluate(async (modelId) => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  providers: Array<{
                    enabledModelIds: string[]
                  }>
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          return result.value?.config.providers[0]?.enabledModelIds.includes(
            modelId,
          )
        }, providerModel),
      )
      .toBe(true)

    const modelSelect = provider
      .locator('.settings-field', { hasText: '主模型' })
      .locator('.n-select')
    await modelSelect.click()
    await expect(
      page.locator('.n-base-select-option', { hasText: providerModel }),
    ).toBeVisible()
    await page
      .locator('.n-base-select-option', { hasText: providerModel })
      .click()
    await expect(modelSelect).toContainText(providerModel)
    await expect(
      discoveredModelRow.getByText('主模型', { exact: true }),
    ).toBeVisible()
    await expect(
      manualModelRow.getByText('主模型', { exact: true }),
    ).toHaveCount(0)
    await expect(manualModelDelete).toBeEnabled()
    await manualModelDelete.click()
    const deleteModelConfirm = page.locator('.n-popconfirm:visible')
    await expect(deleteModelConfirm).toContainText(manualModel)
    await deleteModelConfirm.getByRole('button', { name: '删除' }).click()
    await expect(manualModelRow).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(async (modelId) => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  providers: Array<{
                    modelCatalog: Array<{ id: string }>
                    enabledModelIds: string[]
                    modelOverrides: Record<string, unknown>
                  }>
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          const configured = result.value?.config.providers[0]
          return {
            catalog: configured?.modelCatalog.some(
              (model) => model.id === modelId,
            ),
            enabled: configured?.enabledModelIds.includes(modelId),
            configured: Object.hasOwn(
              configured?.modelOverrides ?? {},
              modelId,
            ),
          }
        }, manualModel),
      )
      .toEqual({ catalog: false, enabled: false, configured: false })

    await expect(
      settingsNavigation.getByRole('menuitem', { name: '自动审批' }),
    ).toHaveCount(0)
    await settingsNavigation.getByRole('menuitem', { name: '权限' }).click()
    const approval = page.locator('.settings-section')
    await expect(
      approval.getByRole('heading', { name: '自动审批' }),
    ).toBeVisible()
    const approvalModel = approval
      .locator('.settings-field', { hasText: '自动审批模型' })
      .locator('.n-select')
    await approvalModel.click()
    await page.getByText(providerModel, { exact: true }).click()
    const approvalReasoning = approval
      .locator('.settings-field', { hasText: '自动审批思考深度' })
      .locator('.n-select')
    await approvalReasoning.click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('最高', { exact: true })
      .click()
    await approval.getByRole('button', { name: '保存自动审批' }).click()
    await expect(approval.locator('.settings-save-status')).toHaveText('已保存')

    await settingsNavigation.getByRole('menuitem', { name: '模型服务' }).click()
    await expect.poll(() => fakeProvider.modelCatalogRequests).toBe(2)
    await expect(
      page.locator('.provider-model-settings-row', { hasText: providerModel }),
    ).toBeVisible()
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
                reasoning: string
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
      reasoning: 'max',
    })
  })

  test('edits per-model annotations with autosave and restores them after reload', async () => {
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
        providerId: 'e2e-annotated',
        label: 'E2E Annotated',
        providerType: 'generic.chat-completions',
        baseURL: 'https://provider.example/v1',
        model: 'annotated-model',
        enabledModelIds: ['annotated-model', 'second-model'],
        reasoning: 'high',
        limits: current.value.config.limits,
      })
      return result.ok
    })
    expect(seeded).toBe(true)

    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1120, 800)
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', { name: '设置分类' })
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')
    await provider
      .locator('.provider-card', { hasText: 'E2E Annotated' })
      .click()

    // The six-column model grid must not overflow the settings content.
    const expectNoHorizontalOverflow = async () => {
      const layout = await provider.evaluate((section) => ({
        clientWidth: section.clientWidth,
        scrollWidth: section.scrollWidth,
      }))
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
    }
    await expectNoHorizontalOverflow()

    // Annotate efforts excluding the provider default 'high': autosave must
    // pause with a field-level hint instead of failing in a loop.
    const clickSelectOption = (text: string) =>
      page
        .locator('.n-select-menu:visible .n-base-select-option')
        .getByText(text, { exact: true })
        .click()
    const effortsField = provider.locator(
      '.provider-model-value[aria-label*="annotated-model"][aria-label*="思考档位"]',
    )
    await effortsField.locator('.n-select').click()
    await clickSelectOption('低')
    await clickSelectOption('中')
    await provider.locator('.settings-heading').first().click()
    await expect(page.locator('.n-select-menu:visible')).toHaveCount(0)
    await expect(
      provider.getByText('自动保存已暂停', { exact: false }),
    ).toBeVisible()
    await expect(provider.locator('.settings-save-status')).not.toHaveText(
      '已保存',
    )

    // Manually picking a supported default resumes autosave.
    await provider
      .locator('.settings-field', { hasText: '思考深度' })
      .locator('.n-select')
      .click()
    await clickSelectOption('低')
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')

    const capabilityField = provider.locator(
      '.provider-model-value[aria-label*="annotated-model"][aria-label*="能力等级"]',
    )
    await capabilityField.locator('.n-select').click()
    await clickSelectOption('强力')
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')

    // The minimum window width must not overflow either.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(960, 700)
    })
    await expectNoHorizontalOverflow()
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1120, 800)
    })

    // Reload restores the annotations.
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    await provider
      .locator('.provider-card', { hasText: 'E2E Annotated' })
      .click()
    await expect(effortsField).toContainText('低')
    await expect(effortsField).toContainText('中')
    await expect(capabilityField).toContainText('强力')

    // Make the annotated provider active and exercise the composer reasoning
    // validity states through the real facade.
    await provider.getByRole('button', { name: '设为默认' }).click()
    await page.locator('.settings-back-button').click()
    // Composer reasoning options are labeled "思考深度 · X", so match loosely.
    const clickComposerOption = (text: string) =>
      page
        .locator('.n-select-menu:visible .n-base-select-option', {
          hasText: text,
        })
        .click()
    const modelSelect = page.getByTestId('composer-model-select')
    const reasoningSelect = page.getByTestId('composer-reasoning-select')
    const reasoningSelectBox = reasoningSelect.locator('.n-base-selection')
    await expect(reasoningSelectBox).not.toHaveClass(/error-status/u)

    // Switch to the unannotated model and pick 'max' (allowed there).
    await modelSelect.click()
    await clickComposerOption('second-model')
    await reasoningSelect.click()
    await clickComposerOption('最高')

    // Switching back to the annotated model keeps 'max', which is unsupported:
    // the select shows an error and send stays blocked until the user fixes it.
    await modelSelect.click()
    await clickComposerOption('annotated-model')
    await expect(reasoningSelectBox).toHaveClass(/error-status/u)

    // Manually picking a supported effort clears the error state.
    await reasoningSelect.click()
    await clickComposerOption('低')
    await expect(reasoningSelectBox).not.toHaveClass(/error-status/u)
  })

  test('configures and persists the model pool from Agents settings', async () => {
    const credentialReady = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      const result = await api.setConfig({
        version: 1,
        kind: 'credential',
        providerId: 'e2e-annotated',
        action: 'set',
        apiKey: 'e2e-model-pool-key',
      })
      return result.ok
    })
    expect(credentialReady).toBe(true)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', { name: '设置分类' })
    await navigation.getByRole('menuitem', { name: 'Agents' }).click()
    const pool = page.locator('.model-pool-section')

    await expect(pool.getByRole('heading', { name: '模型池' })).toBeVisible()
    const transfer = pool.getByTestId('model-pool-transfer')
    const source = transfer.locator('.n-transfer-list--source')
    const target = transfer.locator('.n-transfer-list--target')
    await expect(
      source.getByText('E2E Annotated', { exact: true }),
    ).toBeVisible()
    await expect(
      source.getByText('annotated-model', { exact: true }),
    ).toBeVisible()
    await expect(
      source
        .locator('.n-tree-node-content', { hasText: 'annotated-model' })
        .getByText('强力', { exact: true }),
    ).toBeVisible()
    await expect(source.getByText('低', { exact: true })).toBeVisible()
    await expect(source.getByText('中', { exact: true })).toBeVisible()

    await pool.getByTestId('model-pool-reasoning-floor').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('≥ 中', { exact: true })
      .click()
    await expect(source.getByText('低', { exact: true })).toHaveCount(0)
    await source.getByText('中', { exact: true }).click()
    await expect(target.getByText('中', { exact: true })).toBeVisible()
    await pool.getByRole('button', { name: '保存模型池' }).click()
    await expect(pool.locator('.settings-save-status')).toHaveText('已保存')

    const savedPool = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getConfig(payload: unknown): Promise<{
          value?: {
            config: {
              modelPool: {
                entries: Array<Record<string, unknown>>
              }
            }
          }
        }>
      }
      const result = await api.getConfig({
        version: 1,
        section: 'modelPool',
      })
      return result.value?.config.modelPool
    })
    expect(savedPool).toEqual({
      entries: [
        {
          id: 'worker-1',
          enabled: true,
          providerId: 'e2e-annotated',
          model: 'annotated-model',
          reasoning: 'medium',
        },
      ],
    })
    expect(JSON.stringify(savedPool)).not.toContain('capability')

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    await navigation.getByRole('menuitem', { name: 'Agents' }).click()
    await expect(
      target.getByText('E2E Annotated', { exact: true }),
    ).toBeVisible()
    await expect(
      target.getByText('annotated-model', { exact: true }),
    ).toBeVisible()
    await expect(target.getByText('中', { exact: true })).toBeVisible()

    await target.getByText('中', { exact: true }).click()
    await pool.getByRole('button', { name: '保存模型池' }).click()
    await expect(pool.locator('.n-empty')).toBeVisible()
  })

  test('pauses provider autosave when the draft breaks the saved approval route', async () => {
    // The saved approval route uses the annotated provider's second model.
    const seeded = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      const result = await api.setConfig({
        version: 1,
        kind: 'approval',
        approverProviderId: 'e2e-annotated',
        approverModel: 'second-model',
        reasoning: 'low',
      })
      return result.ok
    })
    expect(seeded).toBe(true)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', { name: '设置分类' })
    // Leave a different approval model in the form without saving. Provider
    // conflict checks must still use the persisted second-model route.
    await navigation.getByRole('menuitem', { name: '权限' }).click()
    const approval = page.locator('.settings-section')
    await approval
      .locator('.settings-field', { hasText: '自动审批模型' })
      .locator('.n-select')
      .click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: 'annotated-model',
      })
      .click()
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('.settings-section')
    await provider
      .locator('.provider-card', { hasText: 'E2E Annotated' })
      .click()

    // Annotating the approval model so it excludes the saved approval effort
    // would break that route: autosave pauses with a hint instead of failing
    // against the backend.
    const secondEffortsField = provider.locator(
      '.provider-model-value[aria-label*="second-model"][aria-label*="思考档位"]',
    )
    await secondEffortsField.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('中', { exact: true })
      .click()
    await provider.locator('.settings-heading').first().click()
    await expect(
      provider.getByText('不支持其已配置的审批档位', { exact: false }),
    ).toBeVisible()
    await expect(provider.locator('.settings-save-status')).not.toHaveText(
      '已保存',
    )

    // Widening the annotation to include the saved effort resumes autosave.
    await secondEffortsField.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('低', { exact: true })
      .click()
    await provider.locator('.settings-heading').first().click()
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')

    // Disabling the persisted approval model must also pause autosave before
    // the backend rejects the Provider update.
    const modelTransfer = provider.getByTestId('provider-model-transfer')
    await expect(
      modelTransfer
        .locator('.n-transfer-list-item--target', {
          hasText: 'annotated-model',
        })
        .getByRole('button', { name: 'close' }),
    ).toHaveCount(0)
    const approvalModelItem = modelTransfer.locator(
      '.n-transfer-list-item--target',
      { hasText: 'second-model' },
    )
    await approvalModelItem.hover()
    await approvalModelItem.getByRole('button', { name: 'close' }).click()
    await expect(
      provider.getByText('已不在当前 Provider 草稿的启用模型中', {
        exact: false,
      }),
    ).toBeVisible()
    await expect(provider.locator('.settings-save-status')).not.toHaveText(
      '已保存',
    )

    // Re-enabling the model clears the conflict and resumes autosave.
    await modelTransfer
      .locator('.n-transfer-list-item--source', { hasText: 'second-model' })
      .click()
    await expect(provider.locator('.settings-save-status')).toHaveText('已保存')
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
