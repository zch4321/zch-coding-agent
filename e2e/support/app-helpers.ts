import { expect, type Page } from '@playwright/test'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PermissionMode } from '../../shared/config'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import type { TraceObject } from './fake-provider'

export async function latestTrace(input: {
  userDataPath: string
}): Promise<{ traceId: string; events: TraceObject[]; raw: string }> {
  const traceDirectory = path.join(input.userDataPath, 'traces')
  const files = await Promise.all(
    (await readdir(traceDirectory))
      .filter((file) => file.endsWith('.jsonl'))
      .map(async (file) => ({
        file,
        mtimeMs: (await stat(path.join(traceDirectory, file))).mtimeMs,
      })),
  )
  const latest = files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
  if (!latest) {
    throw new Error('Expected at least one trace file')
  }
  const raw = await readFile(path.join(traceDirectory, latest.file), 'utf8')
  return {
    traceId: latest.file.slice(0, -'.jsonl'.length),
    raw,
    events: raw
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TraceObject),
  }
}

export async function configureApp(input: {
  page: Page
  providerBaseURL: string
  workspace: string
  defaultMode: PermissionMode
  assistantLanguage?: 'zh-CN' | 'en-US'
  traceLogging?: boolean
}) {
  const workspace = await realpath(input.workspace)
  const result = await input.page.evaluate(
    async ({
      providerBaseURL,
      workspace,
      defaultMode,
      assistantLanguage,
      providerNoticeVersion,
      traceNoticeVersion,
      traceLogging,
    }) => {
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      type ConfigValue = {
        config: {
          assistant: { language: string }
          logging: { enabled: boolean }
          limits: Record<string, unknown>
        }
      }
      type AgentApiForSetup = {
        getConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
        setConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
        getBootstrap(
          payload: unknown,
        ): Promise<IpcResult<{ projects: Array<{ id: string; path: string }> }>>
        addProject(payload: unknown): Promise<IpcResult<unknown>>
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
        providerType: 'generic.chat-completions',
        baseURL: providerBaseURL,
        model: 'e2e-functional-model',
        contextWindowTokens: null,
        maxOutputTokens: null,
        reasoning: 'off',
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

      const approval = await api.setConfig({
        version: 1,
        kind: 'approval',
        approverProviderId: 'deepseek',
        approverModel: 'e2e-functional-model',
      })
      if (!approval.ok) {
        return {
          ok: false,
          step: 'approval',
          message: approval.error.message,
        }
      }

      if (assistantLanguage) {
        const assistant = await api.setConfig({
          version: 1,
          kind: 'assistant',
          value: {
            language: assistantLanguage,
            preferences: {
              'zh-CN': '',
              'en-US': '',
            },
          },
        })
        if (!assistant.ok) {
          return {
            ok: false,
            step: 'assistant',
            message: assistant.error.message,
          }
        }
      }

      const privacy = await api.setConfig({
        version: 1,
        kind: 'privacy',
        providerNoticeAccepted: {
          version: providerNoticeVersion,
          acceptedAt: new Date().toISOString(),
        },
        ...(traceLogging
          ? {
              traceNoticeAccepted: {
                version: traceNoticeVersion,
                acceptedAt: new Date().toISOString(),
              },
            }
          : {}),
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

      if (traceLogging) {
        const logging = await api.setConfig({
          version: 1,
          kind: 'logging',
          value: {
            enabled: true,
            retentionDays: 14,
            maxTotalBytes: 500_000_000,
          },
        })
        if (!logging.ok) {
          return {
            ok: false,
            step: 'logging',
            message: logging.error.message,
          }
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

      const bootstrap = await api.getBootstrap({ version: 1 })
      if (!bootstrap.ok) {
        return {
          ok: false,
          step: 'app:get-bootstrap',
          message: bootstrap.error.message,
        }
      }
      if (
        !bootstrap.value.projects.some((project) => project.path === workspace)
      ) {
        const added = await api.addProject({
          version: 1,
          path: workspace,
        })
        if (!added.ok) {
          return {
            ok: false,
            step: 'project:add',
            message: added.error.message,
          }
        }
      }

      const finalConfig = await api.getConfig({ version: 1, section: 'all' })
      if (!finalConfig.ok) {
        return {
          ok: false,
          step: 'config:get-final',
          message: finalConfig.error.message,
        }
      }
      if (
        assistantLanguage &&
        finalConfig.value.config.assistant.language !== assistantLanguage
      ) {
        return {
          ok: false,
          step: 'assistant-final',
          message: `Expected assistant language ${assistantLanguage}, got ${finalConfig.value.config.assistant.language}`,
        }
      }
      if (traceLogging && finalConfig.value.config.logging.enabled !== true) {
        return {
          ok: false,
          step: 'logging-final',
          message: 'Trace logging was not enabled',
        }
      }

      return { ok: true }
    },
    {
      providerBaseURL: input.providerBaseURL,
      workspace,
      defaultMode: input.defaultMode,
      assistantLanguage: input.assistantLanguage,
      providerNoticeVersion: PROVIDER_NOTICE_VERSION,
      traceNoticeVersion: TRACE_NOTICE_VERSION,
      traceLogging: input.traceLogging ?? false,
    },
  )

  expect(result).toEqual({ ok: true })
}

export async function setAssistantLanguage(
  page: Page,
  language: 'zh-CN' | 'en-US',
): Promise<void> {
  const result = await page.evaluate(async (assistantLanguage) => {
    type IpcResult<Value> =
      | { ok: true; value: Value }
      | { ok: false; error: { message: string } }
    type ConfigValue = { config: { assistant: { language: string } } }
    const api = Reflect.get(window, 'agentApi') as {
      getConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
      setConfig(payload: unknown): Promise<IpcResult<ConfigValue>>
    }
    const saved = await api.setConfig({
      version: 1,
      kind: 'assistant',
      value: {
        language: assistantLanguage,
        preferences: {
          'zh-CN': '',
          'en-US': '',
        },
      },
    })
    if (!saved.ok) {
      return { ok: false, message: saved.error.message }
    }
    const current = await api.getConfig({ version: 1, section: 'all' })
    if (!current.ok) {
      return { ok: false, message: current.error.message }
    }
    return { ok: true, language: current.value.config.assistant.language }
  }, language)

  expect(result).toEqual({ ok: true, language })
}

export async function findDurableMessageText(
  page: Page,
  query: string,
  kind: 'user_input' | 'assistant_turn' | 'interjection',
): Promise<string> {
  return page.evaluate(
    async ({ searchText, messageKind }) => {
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      type SearchHit = { session: { id: string } }
      type Message = {
        kind: string
        parts: Array<{ type: string; text?: string }>
      }
      const api = Reflect.get(window, 'agentApi') as {
        searchSessions(
          payload: unknown,
        ): Promise<IpcResult<{ hits: SearchHit[] }>>
        listMessages(
          payload: unknown,
        ): Promise<IpcResult<{ page: { records: Message[] } }>>
      }
      const search = await api.searchSessions({
        version: 1,
        text: searchText,
        limit: 10,
      })
      if (!search.ok) return ''
      for (const hit of search.value.hits) {
        const listed = await api.listMessages({
          version: 1,
          sessionId: hit.session.id,
          limit: 200,
        })
        if (!listed.ok) continue
        const message = listed.value.page.records.find(
          (candidate) => candidate.kind === messageKind,
        )
        const text = message?.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
        if (text) return text
      }
      return ''
    },
    { searchText: query, messageKind: kind },
  )
}

/** Starts a Durable Session and waits for its initial run to finish successfully. */
export async function startDurableSession(input: {
  page: Page
  workspace: string
  title: string
  message: string
}): Promise<string> {
  const workspace = await realpath(input.workspace)
  const result = await input.page.evaluate(
    async ({ workspace, title, message }) => {
      type IpcResult<Value> =
        | { ok: true; value: Value }
        | { ok: false; error: { message: string } }
      type Project = { id: string; path: string }
      type RunTerminalEvent = {
        type: 'run.status'
        sessionId: string
        runId: string
        status: 'completed' | 'cancelled' | 'failed'
        error?: { message: string }
      }
      const api = Reflect.get(window, 'agentApi') as {
        getBootstrap(
          payload: unknown,
        ): Promise<IpcResult<{ projects: Project[] }>>
        addProject(
          payload: unknown,
        ): Promise<IpcResult<{ commit: { change: { projects: Project[] } } }>>
        startRun(
          payload: unknown,
        ): Promise<IpcResult<{ outcome: string; runId?: string }>>
        onAgentEvent(
          listener: (envelope: {
            event: {
              type: string
              sessionId?: string
              runId?: string
              status?: string
              error?: { message: string }
            }
          }) => void,
        ): () => void
      }
      const bootstrap = await api.getBootstrap({ version: 1 })
      if (!bootstrap.ok) throw new Error(bootstrap.error.message)
      let project = bootstrap.value.projects.find(
        (candidate) => candidate.path === workspace,
      )
      if (!project) {
        const added = await api.addProject({
          version: 1,
          path: workspace,
        })
        if (!added.ok) throw new Error(added.error.message)
        project = added.value.commit.change.projects.find(
          (candidate) => candidate.path === workspace,
        )
      }
      if (!project) throw new Error('Durable project was not created')
      const sessionId = `session:e2e:${crypto.randomUUID()}`
      let expectedRunId: string | undefined
      let bufferedTerminal: RunTerminalEvent | undefined
      let terminalTimeout: number | undefined
      let resolveTerminal!: (event: RunTerminalEvent) => void
      const terminal = new Promise<RunTerminalEvent>((resolve) => {
        resolveTerminal = resolve
      })
      const unsubscribe = api.onAgentEvent(({ event }) => {
        if (
          event.type !== 'run.status' ||
          event.sessionId !== sessionId ||
          !event.runId ||
          !['completed', 'cancelled', 'failed'].includes(event.status ?? '')
        ) {
          return
        }
        const terminalEvent = event as RunTerminalEvent
        if (!expectedRunId) {
          bufferedTerminal = terminalEvent
        } else if (terminalEvent.runId === expectedRunId) {
          resolveTerminal(terminalEvent)
        }
      })

      try {
        const started = await api.startRun({
          version: 1,
          kind: 'new_session',
          sessionId,
          projectId: project.id,
          title,
          modelSelection: {
            providerId: 'deepseek',
            model: 'e2e-functional-model',
            reasoning: 'off',
          },
          permissionMode: 'readonly',
          message,
          clientRequestId: `request:e2e:${crypto.randomUUID()}`,
        })
        if (!started.ok) throw new Error(started.error.message)
        if (started.value.outcome !== 'started' || !started.value.runId) {
          throw new Error('Expected the initial Durable run to start')
        }
        expectedRunId = started.value.runId
        if (bufferedTerminal?.runId === expectedRunId) {
          resolveTerminal(bufferedTerminal)
        }

        const terminalEvent = await Promise.race([
          terminal,
          new Promise<never>((_, reject) => {
            terminalTimeout = window.setTimeout(
              () => reject(new Error('Timed out waiting for Durable run')),
              20_000,
            )
          }),
        ])
        if (terminalEvent.status !== 'completed') {
          throw new Error(
            terminalEvent.error?.message ??
              `Durable run ended with ${terminalEvent.status}`,
          )
        }
        return sessionId
      } finally {
        if (terminalTimeout !== undefined) {
          window.clearTimeout(terminalTimeout)
        }
        unsubscribe()
      }
    },
    {
      workspace,
      title: input.title,
      message: input.message,
    },
  )
  return result
}
