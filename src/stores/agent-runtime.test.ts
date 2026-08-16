// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { isReactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type { AgentApi } from '../../shared/agent-api'
import type { ProviderPublicConfig } from '../../shared/config'
import type { DurableRunStartPayload } from '../../shared/domain-state-api'
import type {
  CallId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionRecord } from '../../shared/session'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useAgentSettingsStore } from './agent-settings'
import { useNotificationStore } from './notifications'

const projectId = 'project:runtime-test' as ProjectId
const selectedSessionId = 'session:selected' as SessionId
const backgroundSessionId = 'session:background' as SessionId
const timestamp = '2026-07-25T00:00:00.000Z'

const project: ProjectRecord = {
  schemaVersion: 1,
  id: projectId,
  path: 'F:/workspace/runtime-test',
  name: 'runtime-test',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}

function session(
  id: SessionId = selectedSessionId,
  revision = 1,
): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    title: `Session ${id}`,
    titleSource: 'user',
    lifecycle: 'active',
    permissionMode: 'readonly',
    modelSelection: {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'off',
    },
    goal: null,
    plan: null,
    revision,
    lastSeq: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function userMessage(
  id: SessionId = selectedSessionId,
  messageId = 'message:user' as MessageId,
): Extract<MessageRecord, { kind: 'user_input' }> {
  return {
    schemaVersion: 1,
    id: messageId,
    sessionId: id,
    seq: 1,
    visibility: 'visible',
    turnId: messageId,
    inHistory: true,
    createdAt: timestamp,
    kind: 'user_input',
    clientRequestId: `request:${messageId}`,
    parts: [{ type: 'text', text: 'User request' }],
    metadata: {
      schemaVersion: 1,
      submission: { type: 'message' },
    },
  }
}

function runtimeSnapshot(id: SessionId, runId: RunId): ActiveRunPublicSnapshot {
  return {
    schemaVersion: 1,
    sessionId: id,
    runId,
    status: 'running_tools',
    text: '',
    reasoning: '',
    tools: [],
    interjections: [],
  }
}

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

function failure(message: string) {
  return {
    version: 1 as const,
    ok: false as const,
    error: { code: 'CONFLICT' as const, message },
  }
}

type AgentEventDraft = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, 'schemaVersion' | 'ts'>
    : never
  : never

function event(value: AgentEventDraft): AgentEvent {
  return {
    schemaVersion: 1,
    ts: timestamp,
    ...value,
  } as AgentEvent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function installApi(api: Partial<AgentApi>): void {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: {
      getSession: async (payload: { sessionId: SessionId }) =>
        success({
          version: 1 as const,
          snapshot: {
            schemaVersion: 1 as const,
            session: session(payload.sessionId),
            messagePage: {
              schemaVersion: 1 as const,
              sessionId: payload.sessionId,
              records: [],
              hasMore: false as const,
            },
          },
        }),
      ...api,
    } as AgentApi,
  })
}

function seedReplica(includeBackground = false) {
  const replica = useAgentReplicaStore()
  replica.projects = [project]
  replica.sessions = [
    session(),
    ...(includeBackground ? [session(backgroundSessionId)] : []),
  ]
  replica.selectedProjectId = projectId
  replica.selectedSessionId = selectedSessionId
  replica.messagesBySessionId[selectedSessionId] = [userMessage()]
  return replica
}

function provider(
  id: string,
  model: string,
  catalogModels: string[],
): ProviderPublicConfig {
  return {
    id,
    label: id,
    providerType: 'generic.chat-completions',
    revision: 1,
    baseURL: 'https://provider.example/v1',
    model,
    reasoning: 'off',
    modelCatalog: catalogModels.map((catalogModel) => ({ id: catalogModel })),
    modelOverrides: {},
    enabledModelIds: [model],
    credentialConfigured: true,
    credentialSource: 'safe-storage',
  }
}

describe('agent runtime store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('derives composer models from the selected Session provider', () => {
    const replica = seedReplica()
    replica.sessions[0]!.modelSelection = {
      providerId: 'provider-b',
      model: 'provider-b-selected',
      reasoning: 'off',
    }
    const settings = useAgentSettingsStore()
    settings.activeProviderId = 'provider-a'
    settings.selectedProviderId = 'provider-a'
    settings.providers = [
      provider('provider-a', 'provider-a-default', ['provider-a-catalog']),
      provider('provider-b', 'provider-b-default', ['provider-b-catalog']),
    ]
    settings.modelProfiles = [
      {
        id: 'provider-a-catalog',
        availability: 'provider',
        capabilitySource: 'default',
        contextWindowTokens: 256_000,
        compactThresholdTokens: 198_246,
        maxOutputTokens: 8_192,
      },
    ]

    const runtime = useAgentRuntimeStore()

    expect(runtime.composerProviderId).toBe('provider-b')
    expect(runtime.composerModel).toBe('provider-b-selected')
    expect(runtime.composerReasoning).toBe('off')
    expect(runtime.composerModelOptions.map((option) => option.value)).toEqual([
      'provider-b-default',
    ])
  })

  it('updates Session model routing without resetting reasoning effort', () => {
    const replica = seedReplica()
    replica.sessions[0]!.modelSelection.reasoning = 'max'
    const runtime = useAgentRuntimeStore()
    const updateModelSelection = vi
      .spyOn(runtime, 'updateModelSelection')
      .mockResolvedValue()

    runtime.setProviderModel('deepseek-reasoner')
    runtime.setProviderReasoning('high')

    expect(updateModelSelection).toHaveBeenNthCalledWith(1, {
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
      reasoning: 'max',
    })
    expect(updateModelSelection).toHaveBeenNthCalledWith(2, {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'high',
    })
  })

  it('blocks sending when the kept reasoning effort is unsupported by the model', () => {
    const replica = seedReplica()
    const settings = useAgentSettingsStore()
    settings.activeProviderId = 'deepseek'
    settings.providers = [
      {
        ...provider('deepseek', 'deepseek-chat', [
          'deepseek-chat',
          'deepseek-lite',
        ]),
        enabledModelIds: ['deepseek-chat', 'deepseek-lite'],
        modelOverrides: {
          'deepseek-lite': { reasoningEfforts: ['low'] },
        },
      },
    ]
    const runtime = useAgentRuntimeStore()
    // The kept effort is never auto-adjusted, but an unsupported value blocks sending.
    replica.sessions[0]!.modelSelection = {
      providerId: 'deepseek',
      model: 'deepseek-lite',
      reasoning: 'max',
    }

    expect(runtime.composerReasoningValid).toBe(false)
    expect(runtime.canSend).toBe(false)

    // Manually picking a supported effort restores sending.
    replica.sessions[0]!.modelSelection = {
      providerId: 'deepseek',
      model: 'deepseek-lite',
      reasoning: 'low',
    }
    expect(runtime.composerReasoningValid).toBe(true)
    expect(runtime.canSend).toBe(true)

    // Unannotated models accept every effort (legacy behavior).
    replica.sessions[0]!.modelSelection = {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'xhigh',
    }
    expect(runtime.composerReasoningValid).toBe(true)
  })

  it('stores reasoning effort on a new-conversation draft route', () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.selectedProjectId = projectId
    const settings = useAgentSettingsStore()
    settings.activeProviderId = 'provider-a'
    settings.providers = [
      provider('provider-a', 'provider-a-default', ['provider-a-catalog']),
    ]
    const runtime = useAgentRuntimeStore()

    runtime.setProviderReasoning('max')

    expect(runtime.draftModelSelection).toEqual({
      providerId: 'provider-a',
      model: 'provider-a-default',
      reasoning: 'max',
    })
    expect(runtime.composerReasoning).toBe('max')
  })

  it('projects a reactive draft route into a clone-safe run payload', async () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.selectedProjectId = projectId
    const settings = useAgentSettingsStore()
    settings.activeProviderId = 'provider-a'
    settings.providers = [
      provider('provider-a', 'provider-a-default', ['provider-a-default']),
    ]
    const startRun = vi.fn(async (payload: DurableRunStartPayload) =>
      success({
        version: 1 as const,
        outcome: 'deduplicated' as const,
        session: session(payload.sessionId),
        userMessage: userMessage(payload.sessionId),
      }),
    )
    installApi({ startRun: startRun as AgentApi['startRun'] })
    const runtime = useAgentRuntimeStore()

    runtime.setProviderReasoning('high')
    expect(isReactive(runtime.draftModelSelection)).toBe(true)

    await expect(
      runtime.sendMessage({ text: 'Use the draft route' }),
    ).resolves.toBe(true)

    const payload = startRun.mock.calls[0]![0]
    expect(payload).toMatchObject({
      kind: 'new_session',
      modelSelection: {
        providerId: 'provider-a',
        model: 'provider-a-default',
        reasoning: 'high',
      },
    })
    expect(() => structuredClone(payload)).not.toThrow()
    expect(runtime.startPending).toBe(false)
  })

  it('clears draft pending state when the run bridge throws', async () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.selectedProjectId = projectId
    const startRun = vi.fn(async () => {
      throw new Error('Run bridge unavailable')
    })
    installApi({ startRun: startRun as AgentApi['startRun'] })
    const runtime = useAgentRuntimeStore()

    await expect(runtime.sendMessage({ text: 'Try once' })).resolves.toBe(false)
    expect(runtime.startPending).toBe(false)
    await expect(runtime.sendMessage({ text: 'Try again' })).resolves.toBe(
      false,
    )

    expect(startRun).toHaveBeenCalledTimes(2)
    expect(runtime.startPending).toBe(false)
    expect(useNotificationStore().pending).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'RUN_START_FAILED',
        message: 'Run bridge unavailable',
      }),
      expect.objectContaining({
        severity: 'error',
        code: 'RUN_START_FAILED',
        message: 'Run bridge unavailable',
      }),
    ])
  })

  it('blocks a second draft submission while the first start IPC is pending', async () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.selectedProjectId = projectId
    const pending = deferred<ReturnType<typeof success>>()
    const startRun = vi.fn(async (payload: DurableRunStartPayload) => {
      void payload
      return (await pending.promise) as Awaited<
        ReturnType<AgentApi['startRun']>
      >
    })
    installApi({ startRun })
    const runtime = useAgentRuntimeStore()

    const first = runtime.sendMessage({ text: 'Only once' })
    const second = await runtime.sendMessage({ text: 'Only once' })

    expect(second).toBe(false)
    expect(startRun).toHaveBeenCalledTimes(1)
    const payload = startRun.mock.calls[0]![0]
    const createdSessionId = payload.sessionId
    pending.resolve(
      success({
        version: 1 as const,
        outcome: 'deduplicated' as const,
        session: session(createdSessionId),
        userMessage: userMessage(createdSessionId),
      }),
    )
    await expect(first).resolves.toBe(true)
    expect(runtime.startPending).toBe(false)
  })

  it('blocks duplicate retry IPC calls and preserves the event cursor', async () => {
    const replica = seedReplica()
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:runtime-test',
      sequence: 9,
    }
    const pending = deferred<ReturnType<typeof failure>>()
    const retryRun = vi.fn(async () => pending.promise)
    installApi({ retryRun: retryRun as AgentApi['retryRun'] })
    const runtime = useAgentRuntimeStore()

    const first = runtime.retryUserMessage('message:user')
    const second = await runtime.retryUserMessage('message:user')

    expect(second).toBe(false)
    expect(retryRun).toHaveBeenCalledTimes(1)
    pending.resolve(failure('retry failed'))
    await expect(first).resolves.toBe(false)
    expect(replica.cursor.sequence).toBe(9)
    expect(runtime.startPending).toBe(false)
  })

  it('restores an approval after a rejected decision IPC', async () => {
    seedReplica()
    const decideApproval = vi.fn(async () => failure('approval unavailable'))
    installApi({
      decideApproval: decideApproval as AgentApi['decideApproval'],
    })
    const runtime = useAgentRuntimeStore()
    const overlay = runtime.ensureOverlay(selectedSessionId)
    overlay.runId = 'run:approval' as RunId
    overlay.status = 'awaiting_approval'
    overlay.approval = {
      runId: overlay.runId,
      callId: 'call:approval' as CallId,
      kind: 'tool',
      tool: 'apply_patch',
      args: { patch: 'fixture' },
      reason: 'Apply a change',
      signals: [],
      rememberable: false,
      expiresAt: '2026-07-25T00:05:00.000Z',
      status: 'requested',
      order: 1,
    }

    await expect(runtime.decideApproval({ decision: 'allow' })).resolves.toBe(
      false,
    )

    expect(runtime.approvalSubmitting).toBe(false)
    expect(overlay.approval?.status).toBe('requested')
    expect(useNotificationStore().pending).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'approval unavailable',
        sessionId: selectedSessionId,
      }),
    ])
  })

  it('ignores duplicate runtime events without duplicating stream content', () => {
    seedReplica()
    const runtime = useAgentRuntimeStore()
    const delta = event({
      type: 'assistant.text.delta',
      seq: 1,
      sessionId: selectedSessionId,
      runId: 'run:duplicate-event' as RunId,
      delta: 'once',
    })

    runtime.handleAgentEvent(delta)
    runtime.handleAgentEvent(delta)

    expect(runtime.ensureOverlay(selectedSessionId)).toMatchObject({
      text: 'once',
      lastEventSeq: 1,
    })
  })

  it('continues live tool arrival order after hydrating a running snapshot', () => {
    seedReplica()
    const runtime = useAgentRuntimeStore()
    const snapshot = runtimeSnapshot(
      selectedSessionId,
      'run:hydrated-tools' as RunId,
    )
    snapshot.tools = [
      {
        callId: 'call:first' as CallId,
        tool: 'read_file',
        status: 'completed',
      },
      {
        callId: 'call:second' as CallId,
        tool: 'search_files',
        status: 'running',
      },
    ]

    runtime.hydrateRuntime(snapshot)
    runtime.handleAgentEvent(
      event({
        type: 'tool.proposed',
        seq: 1,
        sessionId: selectedSessionId,
        runId: snapshot.runId,
        callId: 'call:third' as CallId,
        tool: 'run_command',
        args: {},
        reason: 'Continue after reload',
      }),
    )

    expect(runtime.ensureOverlay(selectedSessionId).tools).toEqual([
      expect.objectContaining({ callId: 'call:third', order: 3 }),
      expect.objectContaining({ callId: 'call:first', order: 1 }),
      expect.objectContaining({ callId: 'call:second', order: 2 }),
    ])
  })

  it('runs background carryovers in FIFO order with stable request ids', async () => {
    const replica = seedReplica(true)
    const startRun = vi.fn(async (payload: DurableRunStartPayload) =>
      success({
        version: 1 as const,
        outcome: 'deduplicated' as const,
        session: session(payload.sessionId),
        userMessage: userMessage(
          payload.sessionId,
          `message:${payload.clientRequestId}` as MessageId,
        ),
        runtime: runtimeSnapshot(
          payload.sessionId,
          `run:${payload.clientRequestId}` as RunId,
        ),
      }),
    )
    installApi({ startRun: startRun as AgentApi['startRun'] })
    const runtime = useAgentRuntimeStore()

    runtime.handleAgentEvent(
      event({
        type: 'interjection.carryover',
        seq: 1,
        sessionId: backgroundSessionId,
        runId: 'run:old' as RunId,
        interjectionId: 'interjection:first',
        content: 'first',
        createdAt: '2026-07-25T00:00:01.000Z',
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'interjection.carryover',
        seq: 2,
        sessionId: backgroundSessionId,
        runId: 'run:old' as RunId,
        interjectionId: 'interjection:second',
        content: 'second',
        createdAt: '2026-07-25T00:00:02.000Z',
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 3,
        sessionId: backgroundSessionId,
        runId: 'run:old' as RunId,
        status: 'completed',
      }),
    )

    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    expect(startRun.mock.calls[0]![0]).toMatchObject({
      sessionId: backgroundSessionId,
      message: 'first',
      clientRequestId: 'carryover:interjection:first',
    })
    expect(replica.selectedSessionId).toBe(selectedSessionId)

    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 4,
        sessionId: backgroundSessionId,
        runId: 'run:carryover:interjection:first' as RunId,
        status: 'completed',
      }),
    )
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))
    expect(startRun.mock.calls[1]![0]).toMatchObject({
      sessionId: backgroundSessionId,
      message: 'second',
      clientRequestId: 'carryover:interjection:second',
    })
  })

  it('discards a failed carryover, unlocks input, and continues the FIFO', async () => {
    seedReplica(true)
    const startRun = vi
      .fn<AgentApi['startRun']>()
      .mockResolvedValueOnce(failure('carryover unavailable'))
      .mockImplementationOnce(async (payload) =>
        success({
          version: 1 as const,
          outcome: 'deduplicated' as const,
          session: session(payload.sessionId),
          userMessage: userMessage(
            payload.sessionId,
            `message:${payload.clientRequestId}` as MessageId,
          ),
          runtime: runtimeSnapshot(
            payload.sessionId,
            `run:${payload.clientRequestId}` as RunId,
          ),
        }),
      )
    installApi({ startRun })
    const runtime = useAgentRuntimeStore()
    const overlay = runtime.ensureOverlay(backgroundSessionId)
    runtime.carryoversBySessionId[backgroundSessionId] = [
      {
        id: 'interjection:failed',
        runId: 'run:old' as RunId,
        content: 'discard this',
        createdAt: '2026-07-25T00:00:01.000Z',
      },
      {
        id: 'interjection:next',
        runId: 'run:old' as RunId,
        content: 'continue with this',
        createdAt: '2026-07-25T00:00:02.000Z',
      },
    ]
    overlay.interjections = [
      {
        id: 'interjection:failed',
        status: 'carryover',
        content: 'discard this',
        createdAt: '2026-07-25T00:00:01.000Z',
      },
      {
        id: 'interjection:next',
        status: 'carryover',
        content: 'continue with this',
        createdAt: '2026-07-25T00:00:02.000Z',
      },
    ]

    await expect(runtime.flushCarryovers(backgroundSessionId)).resolves.toBe(
      false,
    )
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))

    expect(runtime.carryoverStartingBySessionId[backgroundSessionId]).toBe(
      undefined,
    )
    expect(
      overlay.interjections.some((item) => item.id === 'interjection:failed'),
    ).toBe(false)
    expect(useNotificationStore().pending).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'CARRYOVER_DISCARDED',
        sessionId: backgroundSessionId,
      }),
    ])
    expect(startRun.mock.calls[1]![0]).toMatchObject({
      message: 'continue with this',
      clientRequestId: 'carryover:interjection:next',
    })
  })

  it('discards queued carryovers when their Session can no longer run', async () => {
    seedReplica()
    const runtime = useAgentRuntimeStore()
    const overlay = runtime.ensureOverlay(backgroundSessionId)
    runtime.carryoversBySessionId[backgroundSessionId] = [
      {
        id: 'interjection:orphaned',
        runId: 'run:old' as RunId,
        content: 'cannot be delivered',
        createdAt: timestamp,
      },
    ]
    overlay.interjections = [
      {
        id: 'interjection:orphaned',
        status: 'carryover',
        content: 'cannot be delivered',
        createdAt: timestamp,
      },
    ]

    await expect(runtime.flushCarryovers(backgroundSessionId)).resolves.toBe(
      false,
    )

    expect(runtime.carryoversBySessionId[backgroundSessionId]).toBeUndefined()
    expect(
      runtime.carryoverStartingBySessionId[backgroundSessionId],
    ).toBeUndefined()
    expect(overlay.interjections).toEqual([])
    expect(useNotificationStore().pending).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'CARRYOVER_DISCARDED',
        sessionId: backgroundSessionId,
      }),
    ])
  })

  it('lets durable interjections and tools replace their live overlays', () => {
    const replica = seedReplica()
    const rootId = 'message:root' as MessageId
    const callId = 'call:durable' as CallId
    replica.messagesBySessionId[selectedSessionId] = [
      {
        schemaVersion: 1,
        id: 'message:interjection' as MessageId,
        sessionId: selectedSessionId,
        seq: 90,
        visibility: 'visible',
        turnId: rootId,
        inHistory: true,
        createdAt: timestamp,
        kind: 'interjection',
        parts: [{ type: 'text', text: 'durable interjection' }],
        metadata: {
          schemaVersion: 1,
          layer: {
            source: 'run.interjection',
            trusted: false,
            editable: false,
            hash: 'a'.repeat(64),
          },
          interjectionId: 'interjection:durable',
        },
      },
      {
        schemaVersion: 1,
        id: 'message:assistant-tool' as MessageId,
        sessionId: selectedSessionId,
        seq: 100,
        visibility: 'visible',
        turnId: rootId,
        inHistory: true,
        createdAt: timestamp,
        kind: 'assistant_turn',
        modelRoute: {
          schemaVersion: 2,
          purpose: 'main',
          providerType: 'deepseek.chat-completions',
          providerId: 'deepseek',
          model: 'deepseek-chat',
          reasoning: 'off',
          endpoint: 'https://provider.invalid/v1/chat/completions',
          providerConfigRevision: 1,
        },
        parts: [
          {
            type: 'tool_call',
            callId,
            name: 'read_file',
            arguments: { path: 'README.md' },
          },
        ],
      },
      {
        schemaVersion: 1,
        id: 'message:tool-result' as MessageId,
        sessionId: selectedSessionId,
        seq: 101,
        visibility: 'visible',
        turnId: rootId,
        inHistory: true,
        createdAt: timestamp,
        kind: 'tool_result',
        parts: [
          {
            type: 'tool_result',
            callId,
            content: [{ type: 'json', value: { status: 'ok' } }],
            isError: false,
          },
        ],
        metadata: {
          schemaVersion: 1,
          tool: {
            name: 'read_file',
            status: 'completed',
            reason: 'Read',
            truncated: false,
          },
        },
      },
    ]
    const runtime = useAgentRuntimeStore()
    const overlay = runtime.ensureOverlay(selectedSessionId)
    overlay.runId = 'run:live' as RunId
    overlay.interjections = [
      {
        id: 'interjection:durable',
        status: 'injected',
        content: 'durable interjection',
        createdAt: timestamp,
      },
    ]
    overlay.tools = [
      {
        callId,
        runId: 'run:live' as RunId,
        tool: 'wrong-live-copy',
        args: {},
        reason: '',
        status: 'completed',
        order: 1,
      },
      {
        callId: 'call:live' as CallId,
        runId: 'run:live' as RunId,
        tool: 'run_command',
        args: {},
        reason: '',
        status: 'proposed',
        order: 2,
      },
    ]

    const timelineMessages = runtime.timelineTurns.flatMap((turn) => [
      ...(turn.userMessage ? [turn.userMessage] : []),
      ...turn.messages,
    ])
    const timelineTools = runtime.timelineTurns.flatMap((turn) => turn.tools)

    expect(
      timelineMessages.filter((message) => message.role === 'interjection'),
    ).toHaveLength(1)
    expect(
      timelineMessages.find((message) => message.role === 'interjection'),
    ).not.toHaveProperty('live', true)
    expect(timelineTools.find((tool) => tool.callId === callId)).toMatchObject({
      tool: 'read_file',
      order: 100,
    })
    expect(
      timelineTools.find((tool) => tool.callId === 'call:live'),
    ).toMatchObject({ live: true })
  })

  it('accounts writer events in the Session event sequence', () => {
    seedReplica()
    const runtime = useAgentRuntimeStore()
    runtime.handleAgentEvent(
      event({
        type: 'workspace.writer.changed',
        seq: 1,
        sessionId: selectedSessionId,
        workspace: project.path,
        status: 'acquired',
        writerSessionId: selectedSessionId,
        writerRunId: 'run:writer' as RunId,
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 2,
        sessionId: selectedSessionId,
        runId: 'run:writer' as RunId,
        status: 'running_tools',
      }),
    )

    expect(runtime.ensureOverlay(selectedSessionId).lastEventSeq).toBe(2)
  })

  it('reconciles trace capture status in the Session event sequence', () => {
    const replica = seedReplica()
    const runtime = useAgentRuntimeStore()

    runtime.handleAgentEvent(
      event({
        type: 'trace.capture.changed',
        seq: 1,
        sessionId: selectedSessionId,
        capture: {
          configuredEnabled: true,
          state: 'pending',
        },
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'trace.capture.changed',
        seq: 2,
        sessionId: selectedSessionId,
        capture: {
          configuredEnabled: true,
          state: 'active',
          traceId: 'capture-runtime-test',
        },
      }),
    )

    expect(replica.traceCaptureBySessionId[selectedSessionId]).toEqual({
      configuredEnabled: true,
      state: 'active',
      traceId: 'capture-runtime-test',
    })
    expect(runtime.ensureOverlay(selectedSessionId).lastEventSeq).toBe(2)
  })

  it('routes run failures, event gaps, and capture degradation to notifications', async () => {
    seedReplica()
    installApi({})
    const runtime = useAgentRuntimeStore()

    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 1,
        sessionId: selectedSessionId,
        runId: 'run:failed' as RunId,
        status: 'failed',
        error: { code: 'PROVIDER_FAILED', message: 'Provider failed.' },
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'trace.capture.changed',
        seq: 3,
        sessionId: selectedSessionId,
        capture: {
          configuredEnabled: true,
          state: 'degraded',
          warning: 'Capture unavailable.',
        },
      }),
    )

    await vi.waitFor(() => {
      expect(useNotificationStore().pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'PROVIDER_FAILED',
            sessionId: selectedSessionId,
          }),
          expect.objectContaining({
            severity: 'warning',
            code: 'RUNTIME_EVENT_GAP',
            sessionId: selectedSessionId,
          }),
          expect.objectContaining({
            severity: 'warning',
            code: 'TRACE_CAPTURE_DEGRADED',
            sessionId: selectedSessionId,
          }),
        ]),
      )
    })
  })

  it('does not let an old terminal reload clear a newer run overlay', async () => {
    seedReplica()
    const pending = deferred<Awaited<ReturnType<AgentApi['getSession']>>>()
    installApi({ getSession: vi.fn(async () => pending.promise) })
    const runtime = useAgentRuntimeStore()
    const overlay = runtime.ensureOverlay(selectedSessionId)
    overlay.runId = 'run:old' as RunId
    overlay.text = 'old'

    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 1,
        sessionId: selectedSessionId,
        runId: 'run:old' as RunId,
        status: 'completed',
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'run.status',
        seq: 2,
        sessionId: selectedSessionId,
        runId: 'run:new' as RunId,
        status: 'calling_llm',
      }),
    )
    runtime.handleAgentEvent(
      event({
        type: 'assistant.text.delta',
        seq: 3,
        sessionId: selectedSessionId,
        runId: 'run:new' as RunId,
        delta: 'new text',
      }),
    )
    pending.resolve(
      success({
        version: 1 as const,
        snapshot: {
          schemaVersion: 1 as const,
          session: session(),
          messagePage: {
            schemaVersion: 1 as const,
            sessionId: selectedSessionId,
            records: [userMessage()],
            hasMore: false as const,
          },
          runtime: runtimeSnapshot(selectedSessionId, 'run:new' as RunId),
        },
      }),
    )
    await pending.promise
    await Promise.resolve()

    expect(overlay.runId).toBe('run:new')
    expect(overlay.text).toBe('new text')
  })
})
