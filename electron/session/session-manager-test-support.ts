import path from 'node:path'
import type { JsonValue } from '../../shared/json'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'

export interface TraceObject {
  type?: string
  normalizedMessages?: Array<{ role?: string; content?: unknown }>
  promptResources?: Array<{
    id?: string
    version?: string
    path?: string
    sha256?: string
  }>
  promptBuild?: {
    layers?: Array<{ kind?: string; included?: boolean }>
  }
}

class FakeSafeStorage implements SafeStorageAdapter {
  readonly platform = 'win32'

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'system'
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(`encrypted:${value}`)
  }

  async decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return {
      result: value.toString().replace(/^encrypted:/, ''),
      shouldReEncrypt: false,
    }
  }
}

export class ForkProvider implements LLMProvider {
  calls = 0
  messages: ProviderChatRequest['messages'] = []
  providerRequestOverride: JsonValue | undefined

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.messages = structuredClone(request.messages)
    this.providerRequestOverride = structuredClone(
      request.providerRequestOverride,
    )
    yield {
      type: 'completed',
      rawResponse: { id: 'fork-complete' },
      turn: { role: 'assistant', content: 'Fork complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export async function createConfig(
  directory: string,
  secret = 'secret-sentinel',
) {
  const store = new ConfigStore(
    path.join(directory, 'config.json'),
    new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    ),
  )
  await store.initialize()
  await store.update({
    version: 1,
    kind: 'privacy',
    providerNoticeAccepted: {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-17T00:00:00.000Z',
    },
    traceNoticeAccepted: {
      version: TRACE_NOTICE_VERSION,
      acceptedAt: '2026-06-17T00:00:00.000Z',
    },
  })
  await store.update({
    version: 1,
    kind: 'credential',
    action: 'set',
    apiKey: secret,
  })
  await store.update({
    version: 1,
    kind: 'logging',
    value: {
      ...store.getPublicConfig().logging,
      enabled: true,
    },
  })
  return store
}

export function parseTrace(raw: string): TraceObject[] {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TraceObject)
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}
