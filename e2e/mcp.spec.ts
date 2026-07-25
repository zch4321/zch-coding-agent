import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configureApp } from './support/app-helpers'
import {
  providerToolNames,
  textDelta,
  toolCallDelta,
  type FakeProvider,
  type JsonObject,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

const fixture = path.resolve('electron/mcp/fixtures/fake-mcp-server.mjs')

test.describe('Electron MCP gateway workflows', () => {
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

  test('trusts, discovers, approves, restarts and hides a handwritten stdio server', async () => {
    test.setTimeout(60_000)
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await writeMcpConfig(userDataPath)

    await page.locator('.sidebar-settings-button').click()
    const navigation = page.getByRole('navigation', { name: '设置分类' })
    await navigation.getByRole('menuitem', { name: 'MCP 连接' }).click()
    const settings = page.locator('.settings-section')
    await settings.getByRole('button', { name: '重新加载配置' }).click()

    const card = settings.locator('.skill-list article', {
      hasText: 'E2E MCP fixture',
    })
    await expect(card).toContainText('disabled')
    await card.getByRole('switch').click()

    const trustModal = page.locator('.n-modal', {
      hasText: '信任并启用 MCP server？',
    })
    await expect(trustModal).toContainText(process.execPath)
    await expect(trustModal).toContainText(fixture)
    await expect(trustModal).toContainText(`cwd: ${userDataPath}`)
    await trustModal.getByRole('button', { name: '信任并启用' }).click()

    await expect(card).toContainText('ready')
    await expect(card).toContainText('2 个工具')
    await expect(card).toContainText(/PID \d+/u)
    await expect(card).toContainText(/revision [a-f0-9]{12}/u)

    fakeProvider.queue([
      toolCallDelta({
        id: 'call:mcp-list',
        name: 'list_mcp_servers',
        args: { _agent_intent: 'Discover enabled MCP servers' },
      }),
    ])
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:mcp-undisclosed',
        name: 'call_mcp_tool',
        args: {
          serverId: 'e2e-mcp',
          toolName: 'alpha',
          arguments: { value: 'blocked' },
          _agent_intent: 'Verify disclosure enforcement',
        },
      }),
    ])
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:mcp-read',
        name: 'read_mcp_server',
        args: {
          serverId: 'e2e-mcp',
          limit: 1,
          _agent_intent: 'Read the first MCP catalog page',
        },
      }),
    ])
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:mcp-alpha',
        name: 'call_mcp_tool',
        args: {
          serverId: 'e2e-mcp',
          toolName: 'alpha',
          arguments: { value: 'approved-e2e' },
          _agent_intent: 'Call the disclosed alpha tool',
        },
      }),
    ])
    fakeProvider.queue([textDelta('MCP alpha completed.')])

    await page.getByRole('button', { name: '返回主界面' }).click()
    const composer = page.locator('.message-input-area textarea')
    await composer.fill('Exercise the MCP gateway')
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(4)
    const firstMcpTools = mcpProviderTools(fakeProvider.requests[0].body)
    expect(firstMcpTools).toEqual([
      'call_mcp_tool',
      'list_mcp_servers',
      'read_mcp_server',
    ])
    expect(providerToolNames(fakeProvider.requests[0].body)).not.toContain(
      'mcp:e2e-mcp:alpha',
    )
    expect(JSON.stringify(fakeProvider.requests[1].body)).toContain(
      'E2E MCP fixture',
    )
    expect(JSON.stringify(fakeProvider.requests[2].body)).toContain(
      'MCP_TOOL_NOT_DISCLOSED',
    )
    expect(JSON.stringify(fakeProvider.requests[3].body)).toContain(
      'Echo one string value.',
    )

    const approval = page.locator('.approval-card')
    await expect(approval).toContainText('mcp:e2e-mcp:alpha')
    await expect(approval).toContainText('approved-e2e')
    await expect(
      approval.getByRole('button', { name: '批准并记住' }),
    ).toHaveCount(0)
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(5)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'MCP alpha completed.',
    )
    expect(JSON.stringify(fakeProvider.requests[4].body)).toContain(
      'approved-e2e',
    )

    await page.locator('.sidebar-settings-button').click()
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('menuitem', { name: 'MCP 连接' })
      .click()
    const activeCard = page.locator('.settings-section .skill-list article', {
      hasText: 'E2E MCP fixture',
    })
    const firstStatus = await mcpStatus(page)
    await expect(
      activeCard.getByRole('button', { name: '重启连接' }),
    ).toBeVisible()
    await restartMcp(page)
    await expect
      .poll(async () => (await mcpStatus(page))?.stderrTail)
      .not.toBe(firstStatus?.stderrTail)
    await expect(activeCard).toContainText('ready')

    await activeCard.getByRole('switch').click()
    await expect(activeCard).toContainText('disabled')
    await expect.poll(async () => (await mcpStatus(page))?.pid).toBeUndefined()

    fakeProvider.queue([
      toolCallDelta({
        id: 'call:mcp-list-disabled',
        name: 'list_mcp_servers',
        args: { _agent_intent: 'Confirm disabled servers are hidden' },
      }),
    ])
    fakeProvider.queue([textDelta('Disabled MCP server is hidden.')])
    await page.getByRole('button', { name: '返回主界面' }).click()
    await composer.fill('Check MCP visibility after disabling it')
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(7)
    expect(mcpProviderTools(fakeProvider.requests[5].body)).toEqual(
      firstMcpTools,
    )
    expect(lastToolContent(fakeProvider.requests[6].body)).toContain(
      '"servers":[]',
    )
    await expect(page.locator('.chat-message.assistant').last()).toContainText(
      'Disabled MCP server is hidden.',
    )
  })
})

async function writeMcpConfig(userDataPath: string): Promise<void> {
  const file = path.join(userDataPath, 'config.json')
  const config = JSON.parse(await readFile(file, 'utf8')) as JsonObject
  config.mcpServers = [
    {
      id: 'e2e-mcp',
      label: 'E2E MCP fixture',
      description: 'External tools used by the MCP E2E workflow.',
      enabled: false,
      scope: 'global',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { FAKE_STARTUP_MARKER: '1' },
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    },
  ]
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function mcpProviderTools(body: JsonObject): string[] {
  return providerToolNames(body)
    .filter((name) =>
      ['list_mcp_servers', 'read_mcp_server', 'call_mcp_tool'].includes(name),
    )
    .sort()
}

function lastToolContent(body: JsonObject): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const toolMessages = messages.filter(
    (message) =>
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      Reflect.get(message, 'role') === 'tool',
  )
  return String(Reflect.get(toolMessages.at(-1) ?? {}, 'content') ?? '')
}

async function mcpStatus(
  page: Page,
): Promise<{ pid?: number; stderrTail: string } | undefined> {
  return page.evaluate(async () => {
    const api = Reflect.get(window, 'agentApi') as {
      listMcpServers(payload: unknown): Promise<{
        ok: boolean
        value?: {
          servers: Array<{ id: string; pid?: number; stderrTail: string }>
        }
      }>
    }
    const result = await api.listMcpServers({ version: 1 })
    return result.value?.servers.find((server) => server.id === 'e2e-mcp')
  })
}

async function restartMcp(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const api = Reflect.get(window, 'agentApi') as {
      restartMcpServer(payload: unknown): Promise<{
        ok: boolean
        error?: { message: string }
      }>
    }
    return api.restartMcpServer({ version: 1, serverId: 'e2e-mcp' })
  })
  expect(result.ok, result.error?.message).toBe(true)
}
