import { expect, type Page } from '@playwright/test'
import { readdir, readFile, stat } from 'node:fs/promises'
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
          limits: Record<string, unknown>
        }
      }
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

      return { ok: true }
    },
    {
      providerBaseURL: input.providerBaseURL,
      workspace: input.workspace,
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
