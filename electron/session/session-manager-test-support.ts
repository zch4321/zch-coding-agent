import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { JsonValue } from '../../shared/json'
import type { SessionId } from '../../shared/ids'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AgentEventEnvelope,
  TerminalEventEnvelope,
} from '../../shared/ipc-contract'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import { TraceService } from '../logging/service'

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

export function createIpcTestEventSink(
  onAgentEvent: (envelope: AgentEventEnvelope) => void,
  onTerminalEvent: (envelope: TerminalEventEnvelope) => void = () => undefined,
): RuntimeEventSink {
  return {
    publishAgent: (event) => onAgentEvent({ version: IPC_VERSION, event }),
    publishAgentExecution: () => undefined,
    publishTerminal: (event) =>
      onTerminalEvent({ version: IPC_VERSION, event }),
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

export class ForkProvider extends ScriptedProviderHarness {
  calls = 0
  messages: ProviderStreamRequest['normalizedMessages'] = []
  providerRequestOverride: JsonValue | undefined
  providerRequestOverrides: JsonValue[] = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.messages = structuredClone(request.normalizedMessages)
    this.providerRequestOverride = structuredClone(request.providerRequest)
    this.providerRequestOverrides.push(structuredClone(request.providerRequest))
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
  const provider = store.getPublicConfig().models.providers[0]!
  await store.update({
    version: 1,
    kind: 'provider-settings',
    providerId: provider.id,
    label: provider.label,
    providerType: provider.providerType,
    baseURL: provider.baseURL,
    model: 'deepseek-v4-pro',
    enabledModelIds: ['deepseek-v4-pro'],
    limits: store.getPublicConfig().limits,
  })
  await store.update({
    version: 1,
    kind: 'models',
    value: {
      defaultModelProvider: provider.id,
      defaultModel: 'deepseek-v4-pro',
      defaultModelReasoning: 'high',
      auxiliaryModelProvider: provider.id,
      auxiliaryModel: 'deepseek-v4-pro',
      auxiliaryModelReasoning: 'high',
    },
  })
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
      trace: { ...store.getPublicConfig().logging.trace, enabled: true },
    },
  })
  return store
}

export async function readSessionTrace(
  directory: string,
  sessionId: SessionId,
): Promise<string> {
  const traceDirectory = path.join(directory, 'traces')
  const trace = (await new TraceService(traceDirectory).list()).find(
    (candidate) => candidate.sessionId === sessionId,
  )
  if (!trace) throw new Error(`Trace not found for ${sessionId}`)
  return readFile(path.join(traceDirectory, `${trace.traceId}.jsonl`), 'utf8')
}

export function parseTrace(raw: string): TraceObject[] {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TraceObject)
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}
