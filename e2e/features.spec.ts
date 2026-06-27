import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { PermissionMode } from '../shared/config'
import { PROVIDER_NOTICE_VERSION } from '../shared/notices'

type JsonObject = Record<string, unknown>

interface CapturedProviderRequest {
  authorization: string
  body: JsonObject
  url: string
}

interface FakeProvider {
  origin: string
  requests: CapturedProviderRequest[]
  queue(chunks: JsonObject[]): void
  armSecondResponseGate(): void
  releaseSecondResponse(): void
  close(): Promise<void>
}

const providerApiKey = 'e2e-provider-key'
const providerModel = 'e2e-functional-model'

function cleanEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.VITE_DEV_SERVER_URL
  return env
}

async function parseJsonBody(request: IncomingMessage): Promise<JsonObject> {
  let body = ''

  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
  }

  return body ? (JSON.parse(body) as JsonObject) : {}
}

async function startFakeProvider(): Promise<FakeProvider> {
  const queuedResponses: JsonObject[][] = []
  const requests: CapturedProviderRequest[] = []
  // Optional gate that holds the second provider request open until the test
  // releases it, so a mid-run interjection can be queued first.
  let secondResponseGate: (() => void) | undefined
  let secondResponsePromise: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'not found' }))
        return
      }

      requests.push({
        authorization: request.headers.authorization ?? '',
        body: await parseJsonBody(request),
        url: request.url,
      })

      const chunks = queuedResponses.shift()
      if (!chunks) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unexpected provider call' }))
        return
      }

      // Hold the second request open until the test queues an interjection.
      if (requests.length === 2 && secondResponsePromise) {
        await secondResponsePromise
      }

      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      })
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'unknown error',
        }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected fake provider to bind to a TCP port')
  }

  return {
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
    queue(chunks) {
      queuedResponses.push(chunks)
    },
    armSecondResponseGate() {
      secondResponsePromise = new Promise<void>((resolve) => {
        secondResponseGate = resolve
      })
    },
    releaseSecondResponse() {
      if (secondResponseGate) {
        secondResponseGate()
      }
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

function textDelta(text: string, usage?: JsonObject): JsonObject {
  return {
    choices: [{ delta: { content: text } }],
    ...(usage ? { usage } : {}),
  }
}

function toolCallDelta(input: {
  id: string
  name: string
  args: JsonObject
}): JsonObject {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: input.id,
              function: {
                name: input.name,
                arguments: JSON.stringify(input.args),
              },
            },
          ],
        },
      },
    ],
  }
}

function providerToolNames(body: JsonObject): string[] {
  const tools = body.tools
  if (!Array.isArray(tools)) return []

  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return []
    const fn = (tool as JsonObject).function
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return []
    const name = (fn as JsonObject).name
    return typeof name === 'string' ? [name] : []
  })
}

function providerMessageText(body: JsonObject): string {
  const messages = body.messages
  if (!Array.isArray(messages)) return ''

  return messages
    .flatMap((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return []
      }

      const content = (message as JsonObject).content
      return typeof content === 'string' ? [content] : []
    })
    .join('\n')
}

async function configureApp(input: {
  page: Page
  providerBaseURL: string
  workspace: string
  defaultMode: PermissionMode
}) {
  const result = await input.page.evaluate(
    async ({ providerBaseURL, workspace, defaultMode, noticeVersion }) => {
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      type ConfigValue = { config: { limits: Record<string, unknown> } }
      type AgentApiForSetup = {
        getConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
        setConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
      }

      const api = Reflect.get(window, 'agentApi') as AgentApiForSetup
      const current = await api.getConfig({ version: 1, section: 'all' })

      if (!current.ok) {
        return { ok: false, step: 'config:get', message: current.error.message }
      }

      const provider = await api.setConfig({
        version: 1,
        kind: 'provider-settings',
        providerId: 'deepseek',
        label: 'E2E Provider',
        profile: 'generic',
        baseURL: providerBaseURL,
        model: 'e2e-functional-model',
        contextWindowTokens: null,
        maxOutputTokens: null,
        reasoning: 'off',
        approverProviderId: 'deepseek',
        approverModel: 'e2e-functional-model',
        limits: current.value.config.limits,
        apiKey: 'e2e-provider-key',
      })
      if (!provider.ok) {
        return {
          ok: false,
          step: 'provider-settings',
          message: provider.error.message,
        }
      }

      const privacy = await api.setConfig({
        version: 1,
        kind: 'privacy',
        providerNoticeAccepted: {
          version: noticeVersion,
          acceptedAt: new Date().toISOString(),
        },
      })
      if (!privacy.ok) {
        return { ok: false, step: 'privacy', message: privacy.error.message }
      }

      const permission = await api.setConfig({
        version: 1,
        kind: 'permission',
        defaultMode,
        builtinPolicies: true,
        rememberedRules: [],
        sensitiveData: { mode: 'off', pathGlobs: [], contentPatterns: [] },
      })
      if (!permission.ok) {
        return {
          ok: false,
          step: 'permission',
          message: permission.error.message,
        }
      }

      const configuredWorkspace = await api.setConfig({
        version: 1,
        kind: 'workspace',
        lastOpened: workspace,
      })
      if (!configuredWorkspace.ok) {
        return {
          ok: false,
          step: 'workspace',
          message: configuredWorkspace.error.message,
        }
      }

      return { ok: true }
    },
    {
      providerBaseURL: input.providerBaseURL,
      workspace: input.workspace,
      defaultMode: input.defaultMode,
      noticeVersion: PROVIDER_NOTICE_VERSION,
    },
  )

  expect(result).toEqual({ ok: true })
}

test.describe('Electron functional workflows', () => {
  let electronApp: ElectronApplication
  let electronProcess: ChildProcess
  let fakeProvider: FakeProvider
  let page: Page
  let temporaryRoot: string
  let workspace: string

  test.beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-feature-e2e-'))
    workspace = path.join(temporaryRoot, 'workspace')
    await mkdir(workspace)
    fakeProvider = await startFakeProvider()

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`],
      env: cleanEnvironment(),
    })
    electronProcess = electronApp.process()
    page = await electronApp.firstWindow()
    await expect(page.getByTestId('app-ready')).toBeVisible()
  })

  test.afterEach(async () => {
    if (
      electronProcess.exitCode === null &&
      electronProcess.signalCode === null
    ) {
      await electronApp.close()
    }

    await fakeProvider.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('sends workspace context to the provider and persists the assistant reply', async () => {
    await writeFile(
      path.join(workspace, 'notes.md'),
      'Important workspace note from the e2e fixture.\n',
    )
    fakeProvider.queue([
      textDelta('E2E provider saw '),
      textDelta('the workspace context.', {
        prompt_tokens: 11,
        completion_tokens: 6,
        total_tokens: 17,
      }),
    ])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'readonly',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await expect(composer).toBeEnabled()
    await composer.fill('Summarize @notes.md')
    await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect(page.locator('.chat-message.user')).toContainText(
      'Summarize @notes.md',
    )
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'E2E provider saw the workspace context.',
    )
    await expect.poll(() => fakeProvider.requests.length).toBe(1)

    const request = fakeProvider.requests[0]
    expect(request.authorization).toBe(`Bearer ${providerApiKey}`)
    expect(request.body).toMatchObject({
      model: providerModel,
      stream: true,
    })
    expect(providerToolNames(request.body)).toEqual(
      expect.arrayContaining(['read_file', 'create_file']),
    )
    const requestMessages = providerMessageText(request.body)
    expect(requestMessages).toContain('<context_file path="notes.md"')
    expect(requestMessages).toContain(
      'Important workspace note from the e2e fixture',
    )
    expect(requestMessages).toContain('Summarize @notes.md')

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          type Message = { role: string; text: string }
          type Conversation = { messages: Message[] }
          type WorkbenchResult =
            | { ok: true; value: { conversations: Conversation[] } }
            | { ok: false }
          const api = Reflect.get(window, 'agentApi') as {
            getWorkbench(payload: unknown): Promise<WorkbenchResult>
          }
          const workbench = await api.getWorkbench({ version: 1 })
          if (!workbench.ok) return ''
          const conversation = workbench.value.conversations.find((candidate) =>
            candidate.messages.some((message) =>
              message.text.includes('Summarize @notes.md'),
            ),
          )
          return (
            conversation?.messages.find(
              (message) => message.role === 'assistant',
            )?.text ?? ''
          )
        }),
      )
      .toBe('E2E provider saw the workspace context.')
  })

  test('approves a create_file tool call and continues the provider turn', async () => {
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-write',
        name: 'create_file',
        args: {
          path: 'e2e-output.txt',
          content: 'approved by e2e\n',
          _agent_intent: 'Create an e2e output file',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Created e2e-output.txt')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await expect(composer).toBeEnabled()
    await composer.fill('Create e2e-output.txt')
    await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await page.getByRole('button', { name: '发送消息' }).click()

    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('create_file')
    await expect(approval).toContainText('e2e-output.txt')
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    await expect
      .poll(async () =>
        readFile(path.join(workspace, 'e2e-output.txt'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe('approved by e2e\n')
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    await expect(
      page.locator('.tool-call-card', { hasText: 'create_file' }),
    ).toContainText('已完成')
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Created e2e-output.txt',
    )

    const firstRequest = fakeProvider.requests[0]
    const secondRequest = fakeProvider.requests[1]
    expect(providerToolNames(firstRequest.body)).toContain('create_file')
    const secondRequestBody = JSON.stringify(secondRequest.body)
    expect(secondRequestBody).toContain('"role":"tool"')
    expect(secondRequestBody).toContain('"tool_call_id":"call:e2e-write"')
    expect(providerMessageText(secondRequest.body)).toContain(
      '"path":"e2e-output.txt"',
    )
  })

  test('injects a live user interjection after a tool batch mid-run', async () => {
    // First provider turn: a create_file tool call that requires approval in
    // confirm mode. Second provider turn: a final answer that acknowledges the
    // queued interjection. The approval pause gives the test a deterministic
    // window to queue the interjection before the second provider turn.
    fakeProvider.queue([
      toolCallDelta({
        id: 'call:e2e-interject-write',
        name: 'create_file',
        args: {
          path: 'interject-output.txt',
          content: 'interjection run\n',
          _agent_intent: 'Create an output file',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Done after the live interjection.')])

    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()

    const composer = page.locator('.message-input-area textarea')
    await expect(composer).toBeEnabled()
    await composer.fill('Create interject-output.txt')
    await page.getByRole('button', { name: '发送消息' }).click()

    // The create_file tool call requires approval, so the run pauses. This is
    // the deterministic window to queue a live interjection.
    await expect.poll(() => fakeProvider.requests.length).toBe(1)
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await expect(approval).toContainText('create_file')

    await expect(composer).toBeEnabled()
    await composer.fill('Remember to mention the interjection')
    await page.getByRole('button', { name: '发送插话' }).click()

    // The interjection appears as a distinct timeline message while the run is
    // still paused on the approval.
    await expect(
      page.locator('.chat-message.interjection').first(),
    ).toContainText('Remember to mention the interjection')

    // Approve the write so the tool batch completes; the queued interjection
    // is then injected before the second provider continuation.
    await approval.getByRole('button', { name: '批准', exact: true }).click()

    // The run continues (a second provider request fires) and finishes.
    await expect
      .poll(() => fakeProvider.requests.length, { timeout: 15_000 })
      .toBe(2)
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Done after the live interjection.',
    )

    const secondRequest = fakeProvider.requests[1]
    const secondRequestBody = JSON.stringify(secondRequest.body)
    expect(secondRequestBody).toContain('<live_user_interjection>')
    expect(secondRequestBody).toContain('Remember to mention the interjection')

    // The interjection user message must come after the tool result, never
    // interleaved between the assistant tool_call and its tool_result.
    const messages =
      (secondRequest.body.messages as Array<{
        role?: string
        content?: string
      }>) ?? []
    const toolResultIndex = messages.findIndex(
      (message) => message.role === 'tool',
    )
    const interjectionIndex = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<live_user_interjection>'),
    )
    expect(toolResultIndex).toBeGreaterThanOrEqual(0)
    expect(interjectionIndex).toBeGreaterThan(toolResultIndex)

    // The persisted workbench stores the interjection message.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          type Message = { role: string; text: string }
          type Conversation = { messages: Message[] }
          type WorkbenchResult =
            | { ok: true; value: { conversations: Conversation[] } }
            | { ok: false }
          const api = Reflect.get(window, 'agentApi') as {
            getWorkbench(payload: unknown): Promise<WorkbenchResult>
          }
          const workbench = await api.getWorkbench({ version: 1 })
          if (!workbench.ok) return ''
          const conversation = workbench.value.conversations.find((candidate) =>
            candidate.messages.some((message) =>
              message.text.includes('Create interject-output.txt'),
            ),
          )
          return (
            conversation?.messages.find(
              (message) => message.role === 'interjection',
            )?.text ?? ''
          )
        }),
      )
      .toBe('Remember to mention the interjection')
  })
})
