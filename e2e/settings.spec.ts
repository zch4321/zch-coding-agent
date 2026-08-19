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
    await settingsNavigation.getByRole('menuitem', { name: '助手' }).click()
    const general = page.locator('[data-settings-domain="assistant"]')
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

    await settingsNavigation.getByRole('menuitem', { name: '网络' }).click()
    const network = page.locator('[data-settings-domain="network"]')
    await network.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('手动配置', { exact: true })
      .click()
    await network
      .getByPlaceholder('http://127.0.0.1:7890')
      .fill('http://127.0.0.1:7890')
    await network.getByRole('button', { name: '保存网络设置' }).click()
    await expect(network.locator('.settings-save-status')).toHaveText('已保存')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = Reflect.get(window, 'agentApi') as {
            getConfig(payload: unknown): Promise<{
              value?: {
                config: {
                  network: {
                    httpProxy: { mode: string; url?: string }
                  }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'network',
          })
          return result.value?.config.network.httpProxy
        }),
      )
      .toEqual({ mode: 'manual', url: 'http://127.0.0.1:7890' })
    await network.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('关闭', { exact: true })
      .click()
    await network.getByRole('button', { name: '保存网络设置' }).click()
    await expect(network.locator('.settings-save-status')).toHaveText('已保存')

    await settingsNavigation.getByRole('menuitem', { name: '运行' }).click()
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
      hasText: '命令与终端 Shell',
    })
    await expect(commandShell.getByText('实际使用：')).toBeVisible()
    const explicitShell = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        listCommandShells(payload: unknown): Promise<
          | {
              ok: true
              value: {
                profiles: Array<{ id: string; label: string }>
              }
            }
          | { ok: false; error: { message: string } }
        >
      }
      const result = await api.listCommandShells({ version: 1 })
      if (!result.ok) throw new Error(result.error.message)
      const preferredIndex = result.value.profiles.findIndex(
        (profile) => profile.id === 'cmd',
      )
      const profileIndex = preferredIndex >= 0 ? preferredIndex : 0
      const profile = result.value.profiles[profileIndex]
      if (!profile) throw new Error('No command shell profile is available')
      return { ...profile, optionIndex: profileIndex + 1 }
    })
    await commandShell.locator('.n-select').click()
    const explicitShellOption = page
      .locator('.n-select-menu:visible .n-base-select-option')
      .nth(explicitShell.optionIndex)
    await expect(explicitShellOption).toHaveText(explicitShell.label)
    await explicitShellOption.click()
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
      .toBe(explicitShell.id)
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

    const agents = page
      .locator('[data-settings-domain="runtime"]')
      .locator('.settings-section')
      .filter({ has: page.getByRole('heading', { name: 'Agents' }) })
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
    const provider = page.locator('[data-settings-domain="providers"]')

    // Widen the window so the desktop six-column model grid (with header)
    // applies; narrow widths intentionally switch to the stacked layout.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900)
    })

    await expect(provider.locator('.provider-card')).toHaveCount(1)
    await expect(provider.locator('.provider-card')).toContainText('DeepSeek')
    await expect(
      provider.locator('.settings-field > span', {
        hasText: /^Provider 默认模型$/,
      }),
    ).toBeVisible()
    await expect(
      provider.getByText('Token 估算方式', { exact: true }),
    ).toHaveCount(0)
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
                  models: {
                    providers: Array<{
                      modelOverrides: Record<string, unknown>
                    }>
                  }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          return result.value?.config.models.providers[0]?.modelOverrides[
            modelId
          ]
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
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )
    await expect.poll(() => fakeProvider.modelCatalogRequests).toBe(1)
    await expect(refreshModels).toBeEnabled()
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
                  models: {
                    providers: Array<{
                      enabledModelIds: string[]
                    }>
                  }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          return result.value?.config.models.providers[0]?.enabledModelIds.includes(
            modelId,
          )
        }, providerModel),
      )
      .toBe(true)

    const modelSelect = provider
      .locator('.settings-field', { hasText: 'Provider 默认模型' })
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
                  models: {
                    providers: Array<{
                      modelCatalog: Array<{ id: string }>
                      enabledModelIds: string[]
                      modelOverrides: Record<string, unknown>
                    }>
                  }
                }
              }
            }>
          }
          const result = await api.getConfig({
            version: 1,
            section: 'providers',
          })
          const configured = result.value?.config.models.providers[0]
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
    await settingsNavigation.getByRole('menuitem', { name: '安全' }).click()
    const permissions = page.locator('[data-settings-domain="security"]')
    await expect(
      permissions.getByText(
        '自动模式使用辅助模型（未配置时使用当前模型）进行审批',
      ),
    ).toBeVisible()

    await settingsNavigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
    const modelsSection = page.locator('[data-settings-domain="models"]')
    await expect(
      modelsSection.getByTestId('default-model-reasoning-select'),
    ).toContainText('高')
    await expect(
      modelsSection.getByTestId('auxiliary-model-reasoning-select'),
    ).toContainText('高')
    const auxiliaryField = modelsSection.getByTestId(
      'auxiliary-model-role-select',
    )
    await auxiliaryField.click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: providerModel,
      })
      .click()
    await expect(
      modelsSection.getByTestId('model-roles-save-status'),
    ).toHaveText('已保存')

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
    const provider = page.locator('[data-settings-domain="providers"]')

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
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )
    await expect(
      provider.locator('.provider-card', { hasText: 'E2E Alt Edited' }),
    ).toBeVisible()

    const mainModelField = provider
      .locator('.settings-field', { hasText: 'Provider 默认模型' })
      .locator('.n-select')
    await mainModelField.click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: 'e2e-alt-chat',
      })
      .click()
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )

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
              models: {
                auxiliaryModelProvider: string
                auxiliaryModel: string
              }
            }
          }
        }>
      }
      const result = await api.getConfig({ version: 1, section: 'all' })
      return {
        text: JSON.stringify(result),
        roles: result.value?.config.models,
      }
    })
    expect(configSnapshot.text).not.toContain('apiKeyRef')
    expect(configSnapshot.roles).toMatchObject({
      auxiliaryModelProvider: 'deepseek',
      auxiliaryModel: providerModel,
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
    const provider = page.locator('[data-settings-domain="providers"]')
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

    // Provider annotations save independently now that reasoning belongs to
    // exact model roles rather than the Provider.
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
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )

    const capabilityField = provider.locator(
      '.provider-model-value[aria-label*="annotated-model"][aria-label*="能力等级"]',
    )
    await capabilityField.locator('.n-select').click()
    await clickSelectOption('强力')
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )

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

    // Make the annotated model the default and exercise the composer reasoning
    // validity states through the real facade.
    await provider
      .locator('.settings-field', { hasText: 'Provider 默认模型' })
      .locator('.n-select')
      .click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: 'annotated-model',
      })
      .click()
    await navigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
    const models = page.locator('[data-settings-domain="models"]')
    await models.getByTestId('default-model-role-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: 'E2E Annotated / annotated-model',
      })
      .click()
    await expect(
      models.getByText('当前模型不支持这个思考深度', { exact: false }),
    ).toBeVisible()
    await models.getByTestId('default-model-reasoning-select').click()
    await clickSelectOption('中')
    await expect(models.getByTestId('model-roles-save-status')).toHaveText(
      '已保存',
    )
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

  test('configures and persists the model pool from Models settings', async () => {
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
    await navigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
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
              models: {
                modelPool: {
                  entries: Array<Record<string, unknown>>
                }
              }
            }
          }
        }>
      }
      const result = await api.getConfig({
        version: 1,
        section: 'modelPool',
      })
      return result.value?.config.models.modelPool
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
    await navigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
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

  test('pauses provider autosave when the draft breaks the saved auxiliary route', async () => {
    // The saved auxiliary role uses the annotated provider's second model.
    const seeded = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as {
        getConfig(payload: unknown): Promise<{
          ok: boolean
          value?: {
            config: {
              models: {
                defaultModelProvider: string
                defaultModel: string
                defaultModelReasoning: string
              }
            }
          }
        }>
        setConfig(payload: unknown): Promise<{ ok: boolean }>
      }
      const current = await api.getConfig({ version: 1, section: 'all' })
      if (!current.ok || !current.value) return false
      const result = await api.setConfig({
        version: 1,
        kind: 'models',
        value: {
          defaultModelProvider:
            current.value.config.models.defaultModelProvider,
          defaultModel: current.value.config.models.defaultModel,
          defaultModelReasoning:
            current.value.config.models.defaultModelReasoning,
          auxiliaryModelProvider: 'e2e-annotated',
          auxiliaryModel: 'second-model',
          auxiliaryModelReasoning: 'high',
        },
      })
      return result.ok
    })
    expect(seeded).toBe(true)

    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', { name: '设置分类' })
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    const provider = page.locator('[data-settings-domain="providers"]')
    await provider
      .locator('.provider-card', { hasText: 'E2E Annotated' })
      .click()

    // Annotating the auxiliary model so it excludes the role's explicit high
    // effort would break that route: autosave pauses with a hint instead of
    // failing against the backend.
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
      provider.getByText('与当前 Provider 草稿不兼容', { exact: false }),
    ).toBeVisible()
    await expect(provider.getByTestId('provider-save-status')).not.toHaveText(
      '已保存',
    )

    // Changing only the auxiliary role clears the conflict and must restart
    // the paused Provider autosave watcher.
    await navigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
    const models = page.locator('[data-settings-domain="models"]')
    const auxiliaryField = models.getByTestId('auxiliary-model-role-select')
    await auxiliaryField.click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('跟随当前模型（默认）', { exact: true })
      .click()
    await expect(models.getByTestId('model-roles-save-status')).toHaveText(
      '已保存',
    )
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )

    // Widen the saved annotation so the model can become auxiliary again.
    await secondEffortsField.locator('.n-select').click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option')
      .getByText('低', { exact: true })
      .click()
    await provider.locator('.settings-heading').first().click()
    await expect(provider.getByTestId('provider-save-status')).toHaveText(
      '已保存',
    )
    await navigation
      .getByRole('menuitem', { name: '模型', exact: true })
      .click()
    await auxiliaryField.click()
    await page
      .locator('.n-select-menu:visible .n-base-select-option', {
        hasText: 'second-model',
      })
      .click()
    await expect(models.getByTestId('model-roles-save-status')).toHaveText(
      '已保存',
    )
    await navigation.getByRole('menuitem', { name: '模型服务' }).click()

    // Disabling the persisted auxiliary model must also pause autosave before
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
    await expect(provider.getByTestId('provider-save-status')).not.toHaveText(
      '已保存',
    )

    // Re-enabling restores the already-saved Provider snapshot, so the
    // conflict clears without issuing a redundant write.
    await modelTransfer
      .locator('.n-transfer-list-item--source', { hasText: 'second-model' })
      .click()
    await expect(
      provider.getByText('已不在当前 Provider 草稿的启用模型中', {
        exact: false,
      }),
    ).toHaveCount(0)
  })

  test('exposes skill management and bounded trace diagnostics in settings', async () => {
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', {
      name: '设置分类',
    })
    await navigation.getByRole('menuitem', { name: '集成' }).click()
    const integrations = page.locator('[data-settings-domain="integrations"]')
    const skills = integrations
      .locator('.settings-section')
      .filter({ has: page.getByRole('heading', { name: '技能' }) })
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

    const mcp = integrations
      .locator('.settings-section')
      .filter({ has: page.getByRole('heading', { name: 'MCP 连接' }) })
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

    await navigation.getByRole('menuitem', { name: '应用与诊断' }).click()
    const logging = page.locator('[data-settings-domain="application"]')
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
