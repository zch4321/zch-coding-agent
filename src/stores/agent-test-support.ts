import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import type { ConversationRecord as SharedConversationRecord } from '../../shared/workbench'
import { useAgentStore } from './agent'

export const sessionId = 'session:test' as SessionId
export const runId = 'run:test' as RunId
export const callId = 'call:test' as CallId
export const stamp = '2026-06-20T00:00:00.000Z'

export function setupAgentTest(): void {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })
}

export function installApi(api: Partial<AgentApi>) {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
}

export function registerActiveSession(
  store: ReturnType<typeof useAgentStore>,
  value: SessionId = sessionId,
) {
  if (!store.activeConversationId) {
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
  }
  store.registerSession(store.activeConversationId!, value)
}

export function requestApproval(store: ReturnType<typeof useAgentStore>) {
  registerActiveSession(store)
  store.handleAgentEvent({
    schemaVersion: 1,
    seq: 1,
    ts: '2026-06-20T00:00:00.000Z',
    type: 'approval.requested',
    sessionId,
    runId,
    callId,
    kind: 'tool',
    tool: 'create_file',
    args: { path: 'note.txt', content: 'updated' },
    reason: 'Write the requested file',
    policySignals: [],
    diff: '--- a/note.txt\n+++ b/note.txt',
    diffHash: 'diff-hash',
    rememberable: true,
    expiresAt: '2026-06-20T01:00:00.000Z',
  })
}

export function markdownConversation(
  overrides: Partial<SharedConversationRecord> = {},
): SharedConversationRecord {
  return {
    id: 'conversation:imported-source',
    projectPath: 'F:/untrusted/source',
    title: 'Imported source',
    model: 'deepseek-v4-pro',
    mode: 'auto',
    messages: [
      {
        id: 'message:source',
        role: 'user',
        text: 'imported body',
        reasoning: '',
        order: 0,
      },
    ],
    tools: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

export function multiProviderConfig() {
  const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
  config.providers[0].modelCatalog = [
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-pro' },
  ]
  config.providers.push({
    ...structuredClone(config.providers[0]),
    id: 'generic',
    label: 'Generic Provider',
    profile: 'generic',
    baseURL: 'https://generic.example/v1',
    model: 'generic-chat',
    reasoning: 'off',
    modelCatalog: [{ id: 'generic-chat' }, { id: 'generic-coder' }],
    modelOverrides: {
      'generic-large': { contextWindowTokens: 128_000 },
    },
    credentialConfigured: false,
    credentialSource: 'none',
  })
  config.approval.approverProviderId = 'deepseek'
  return config
}
